const _ = require(`lodash`)
const invariant = require(`invariant`)
const {
  isSpecifiedScalarType,
  isIntrospectionType,
  assertValidName,
  GraphQLNonNull,
  GraphQLList,
  GraphQLObjectType,
  GraphQLInterfaceType,
} = require(`graphql`)
const {
  ObjectTypeComposer,
  InterfaceTypeComposer,
  UnionTypeComposer,
  InputTypeComposer,
  ScalarTypeComposer,
  EnumTypeComposer,
  defineFieldMapToConfig,
} = require(`graphql-compose`)
const { getNode, getNodesByType } = require(`../redux/nodes`)

const apiRunner = require(`../utils/api-runner-node`)
const report = require(`gatsby-cli/lib/reporter`)
const { addNodeInterfaceFields } = require(`./types/node-interface`)
const { addInferredType, addInferredTypes } = require(`./infer`)
const {
  findOne,
  findManyPaginated,
  wrappingResolver,
  defaultResolver,
} = require(`./resolvers`)
const {
  processFieldExtensions,
  internalExtensionNames,
} = require(`./extensions`)
import { getPagination } from "./types/pagination"
import { getSortInput, SORTABLE_ENUM } from "./types/sort"
import { getFilterInput, SEARCHABLE_ENUM } from "./types/filter"
import { isGatsbyType, GatsbyGraphQLTypeKind } from "./types/type-builders"

const {
  isASTDocument,
  parseTypeDef,
  reportParsingError,
} = require(`./types/type-defs`)
import { clearDerivedTypes } from "./types/derived-types"
const { printTypeDefinitions } = require(`./print`)

const buildSchema = async ({
  schemaComposer,
  types,
  typeMapping,
  fieldExtensions,
  thirdPartySchemas,
  printConfig,
  typeConflictReporter,
  inferenceMetadata,
  parentSpan,
}) => {
  await updateSchemaComposer({
    schemaComposer,
    types,
    typeMapping,
    fieldExtensions,
    thirdPartySchemas,
    printConfig,
    typeConflictReporter,
    inferenceMetadata,
    parentSpan,
  })
  // const { printSchema } = require(`graphql`)
  const schema = schemaComposer.buildSchema()
  // console.log(printSchema(schema))
  return schema
}

const rebuildSchemaWithSitePage = async ({
  schemaComposer,
  typeMapping,
  fieldExtensions,
  typeConflictReporter,
  inferenceMetadata,
  parentSpan,
}) => {
  const typeComposer = schemaComposer.getOTC(`SitePage`)

  // Clear derived types and fields
  // they will be re-created in processTypeComposer later
  clearDerivedTypes({ schemaComposer, typeComposer })

  const shouldInfer =
    !typeComposer.hasExtension(`infer`) ||
    typeComposer.getExtension(`infer`) !== false
  if (shouldInfer) {
    addInferredType({
      schemaComposer,
      typeComposer,
      typeConflictReporter,
      typeMapping,
      inferenceMetadata,
      parentSpan,
    })
  }
  await processTypeComposer({
    schemaComposer,
    typeComposer,
    fieldExtensions,
    parentSpan,
  })
  return schemaComposer.buildSchema()
}

module.exports = {
  buildSchema,
  rebuildSchemaWithSitePage,
}

const updateSchemaComposer = async ({
  schemaComposer,
  types,
  typeMapping,
  fieldExtensions,
  thirdPartySchemas,
  printConfig,
  typeConflictReporter,
  inferenceMetadata,
  parentSpan,
}) => {
  let activity = report.phantomActivity(`Add explicit types`, {
    parentSpan: parentSpan,
  })
  activity.start()
  await addTypes({ schemaComposer, parentSpan: activity.span, types })
  activity.end()

  activity = report.phantomActivity(`Add inferred types`, {
    parentSpan: parentSpan,
  })
  activity.start()
  await addInferredTypes({
    schemaComposer,
    typeConflictReporter,
    typeMapping,
    inferenceMetadata,
    parentSpan: activity.span,
  })
  activity.end()

  activity = report.phantomActivity(`Processing types`, {
    parentSpan: parentSpan,
  })
  activity.start()
  await printTypeDefinitions({
    config: printConfig,
    schemaComposer,
    parentSpan: activity.span,
  })
  await addSetFieldsOnGraphQLNodeTypeFields({
    schemaComposer,
    parentSpan: activity.span,
  })
  await addConvenienceChildrenFields({
    schemaComposer,
    parentSpan: activity.span,
  })
  await Promise.all(
    Array.from(new Set(schemaComposer.values())).map(typeComposer =>
      processTypeComposer({
        schemaComposer,
        typeComposer,
        fieldExtensions,
        parentSpan: activity.span,
      })
    )
  )
  checkQueryableInterfaces({ schemaComposer, parentSpan: activity.span })
  await addThirdPartySchemas({
    schemaComposer,
    thirdPartySchemas,
    parentSpan: activity.span,
  })
  await addCustomResolveFunctions({ schemaComposer, parentSpan: activity.span })
  await attachTracingResolver({ schemaComposer, parentSpan: activity.span })
  activity.end()
}

const processTypeComposer = async ({
  schemaComposer,
  typeComposer,
  fieldExtensions,
  parentSpan,
}) => {
  if (typeComposer instanceof ObjectTypeComposer) {
    await processFieldExtensions({
      schemaComposer,
      typeComposer,
      fieldExtensions,
      parentSpan,
    })

    if (typeComposer.hasInterface(`Node`)) {
      await addNodeInterfaceFields({ schemaComposer, typeComposer, parentSpan })
      await addImplicitConvenienceChildrenFields({
        schemaComposer,
        typeComposer,
        parentSpan,
      })
    }
    await determineSearchableFields({
      schemaComposer,
      typeComposer,
      parentSpan,
    })

    if (typeComposer.hasInterface(`Node`)) {
      await addTypeToRootQuery({ schemaComposer, typeComposer, parentSpan })
    }
  } else if (typeComposer instanceof InterfaceTypeComposer) {
    if (typeComposer.getExtension(`nodeInterface`)) {
      // We only process field extensions for queryable Node interfaces, so we get
      // the input args on the root query type, e.g. `formatString` etc. for `dateformat`
      await processFieldExtensions({
        schemaComposer,
        typeComposer,
        fieldExtensions,
        parentSpan,
      })
      await determineSearchableFields({
        schemaComposer,
        typeComposer,
        parentSpan,
      })
      await addTypeToRootQuery({ schemaComposer, typeComposer, parentSpan })
    }
  }
}

const fieldNames = {
  query: typeName => _.camelCase(typeName),
  queryAll: typeName => _.camelCase(`all ${typeName}`),
  convenienceChild: typeName => _.camelCase(`child ${typeName}`),
  convenienceChildren: typeName => _.camelCase(`children ${typeName}`),
}

const addTypes = ({ schemaComposer, types, parentSpan }) => {
  types.forEach(({ typeOrTypeDef, plugin }) => {
    if (typeof typeOrTypeDef === `string`) {
      typeOrTypeDef = parseTypeDef(typeOrTypeDef)
    }
    if (isASTDocument(typeOrTypeDef)) {
      let parsedTypes
      const createdFrom = `sdl`
      try {
        parsedTypes = parseTypes({
          doc: typeOrTypeDef,
          plugin,
          createdFrom,
          schemaComposer,
          parentSpan,
        })
      } catch (error) {
        reportParsingError(error)
        return
      }
      parsedTypes.forEach(type => {
        processAddedType({
          schemaComposer,
          type,
          parentSpan,
          createdFrom,
          plugin,
        })
      })
    } else if (isGatsbyType(typeOrTypeDef)) {
      const type = createTypeComposerFromGatsbyType({
        schemaComposer,
        type: typeOrTypeDef,
        parentSpan,
      })

      if (type) {
        const typeName = type.getTypeName()
        const createdFrom = `typeBuilder`
        checkIsAllowedTypeName(typeName)
        if (schemaComposer.has(typeName)) {
          const typeComposer = schemaComposer.get(typeName)
          mergeTypes({
            schemaComposer,
            typeComposer,
            type,
            plugin,
            createdFrom,
            parentSpan,
          })
        } else {
          processAddedType({
            schemaComposer,
            type,
            parentSpan,
            createdFrom,
            plugin,
          })
        }
      }
    } else {
      const typeName = typeOrTypeDef.name
      const createdFrom = `graphql-js`
      checkIsAllowedTypeName(typeName)
      if (schemaComposer.has(typeName)) {
        const typeComposer = schemaComposer.get(typeName)
        mergeTypes({
          schemaComposer,
          typeComposer,
          type: typeOrTypeDef,
          plugin,
          createdFrom,
          parentSpan,
        })
      } else {
        processAddedType({
          schemaComposer,
          type: typeOrTypeDef,
          parentSpan,
          createdFrom,
          plugin,
        })
      }
    }
  })
}

const mergeTypes = ({
  schemaComposer,
  typeComposer,
  type,
  plugin,
  createdFrom,
  parentSpan,
}) => {
  // The merge is considered safe when a user or a plugin owning the type extend this type
  // TODO: add proper conflicts detection and reporting (on the field level)
  const typeOwner = typeComposer.getExtension(`plugin`)
  const isSafeMerge =
    !plugin ||
    plugin.name === `default-site-plugin` ||
    plugin.name === typeOwner

  if (!isSafeMerge) {
    if (typeOwner) {
      report.warn(
        `Plugin \`${plugin.name}\` has customized the GraphQL type ` +
          `\`${typeComposer.getTypeName()}\`, which has already been defined ` +
          `by the plugin \`${typeOwner}\`. ` +
          `This could potentially cause conflicts.`
      )
    } else {
      report.warn(
        `Plugin \`${plugin.name}\` has customized the built-in Gatsby GraphQL type ` +
          `\`${typeComposer.getTypeName()}\`. ` +
          `This is allowed, but could potentially cause conflicts.`
      )
    }
  }

  if (type instanceof ObjectTypeComposer) {
    mergeFields({ typeComposer, fields: type.getFields() })
    type.getInterfaces().forEach(iface => typeComposer.addInterface(iface))
  } else if (type instanceof InterfaceTypeComposer) {
    mergeFields({ typeComposer, fields: type.getFields() })
  } else if (type instanceof GraphQLObjectType) {
    mergeFields({
      typeComposer,
      fields: defineFieldMapToConfig(type.getFields()),
    })
    type.getInterfaces().forEach(iface => typeComposer.addInterface(iface))
  } else if (type instanceof GraphQLInterfaceType) {
    mergeFields({
      typeComposer,
      fields: defineFieldMapToConfig(type.getFields()),
    })
  }

  if (isNamedTypeComposer(type)) {
    typeComposer.extendExtensions(type.getExtensions())
  }

  addExtensions({ schemaComposer, typeComposer, plugin, createdFrom })

  return true
}

const processAddedType = ({
  schemaComposer,
  type,
  parentSpan,
  createdFrom,
  plugin,
}) => {
  const typeName = schemaComposer.addAsComposer(type)
  const typeComposer = schemaComposer.get(typeName)
  if (
    typeComposer instanceof InterfaceTypeComposer ||
    typeComposer instanceof UnionTypeComposer
  ) {
    if (!typeComposer.getResolveType()) {
      typeComposer.setResolveType(node => node.internal.type)
    }
  }
  schemaComposer.addSchemaMustHaveType(typeComposer)

  addExtensions({ schemaComposer, typeComposer, plugin, createdFrom })

  return typeComposer
}

const addExtensions = ({
  schemaComposer,
  typeComposer,
  plugin,
  createdFrom,
}) => {
  typeComposer.setExtension(`createdFrom`, createdFrom)
  typeComposer.setExtension(`plugin`, plugin ? plugin.name : null)

  if (createdFrom === `sdl`) {
    const directives = typeComposer.getDirectives()
    directives.forEach(({ name, args }) => {
      switch (name) {
        case `infer`:
        case `dontInfer`: {
          typeComposer.setExtension(`infer`, name === `infer`)
          if (args.noDefaultResolvers != null) {
            typeComposer.setExtension(
              `addDefaultResolvers`,
              !args.noDefaultResolvers
            )
          }
          break
        }
        case `mimeTypes`:
          typeComposer.setExtension(`mimeTypes`, args)
          break
        case `childOf`:
          typeComposer.setExtension(`childOf`, args)
          break
        case `nodeInterface`:
          if (typeComposer instanceof InterfaceTypeComposer) {
            if (
              !typeComposer.hasField(`id`) ||
              typeComposer.getFieldType(`id`).toString() !== `ID!`
            ) {
              report.panic(
                `Interfaces with the \`nodeInterface\` extension must have a field ` +
                  `\`id\` of type \`ID!\`. Check the type definition of ` +
                  `\`${typeComposer.getTypeName()}\`.`
              )
            }
            typeComposer.setExtension(`nodeInterface`, true)
          }
          break
        default:
      }
    })
  }

  if (
    typeComposer instanceof ObjectTypeComposer ||
    typeComposer instanceof InterfaceTypeComposer ||
    typeComposer instanceof InputTypeComposer
  ) {
    typeComposer.getFieldNames().forEach(fieldName => {
      typeComposer.setFieldExtension(fieldName, `createdFrom`, createdFrom)
      typeComposer.setFieldExtension(
        fieldName,
        `plugin`,
        plugin ? plugin.name : null
      )

      if (createdFrom === `sdl`) {
        const directives = typeComposer.getFieldDirectives(fieldName)
        directives.forEach(({ name, args }) => {
          typeComposer.setFieldExtension(fieldName, name, args)
        })
      }

      // Validate field extension args. `graphql-compose` already checks the
      // type of directive args in `parseDirectives`, but we want to check
      // extensions provided with type builders as well. Also, we warn if an
      // extension option was provided which does not exist in the field
      // extension definition.
      const fieldExtensions = typeComposer.getFieldExtensions(fieldName)
      const typeName = typeComposer.getTypeName()
      Object.keys(fieldExtensions)
        .filter(name => !internalExtensionNames.includes(name))
        .forEach(name => {
          const args = fieldExtensions[name]

          if (!args || typeof args !== `object`) {
            report.error(
              `Field extension arguments must be provided as an object. ` +
                `Received "${args}" on \`${typeName}.${fieldName}\`.`
            )
            return
          }

          try {
            const definition = schemaComposer.getDirective(name)

            // Handle `defaultValue` when not provided as directive
            definition.args.forEach(({ name, defaultValue }) => {
              if (args[name] === undefined && defaultValue !== undefined) {
                args[name] = defaultValue
              }
            })

            Object.keys(args).forEach(arg => {
              const argumentDef = definition.args.find(
                ({ name }) => name === arg
              )
              if (!argumentDef) {
                report.error(
                  `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                    `has invalid argument \`${arg}\`.`
                )
                return
              }
              const value = args[arg]
              try {
                validate(argumentDef.type, value)
              } catch (error) {
                report.error(
                  `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                    `has argument \`${arg}\` with invalid value "${value}". ` +
                    error.message
                )
              }
            })
          } catch (error) {
            report.error(
              `Field extension \`${name}\` on \`${typeName}.${fieldName}\` ` +
                `is not available.`
            )
          }
        })
    })
  }

  if (typeComposer.hasExtension(`addDefaultResolvers`)) {
    report.warn(
      `Deprecation warning - "noDefaultResolvers" is deprecated. In Gatsby 3, ` +
        `defined fields won't get resolvers, unless explicitly added with a ` +
        `directive/extension.`
    )
  }

  return typeComposer
}

const checkIsAllowedTypeName = name => {
  invariant(
    name !== `Node`,
    `The GraphQL type \`Node\` is reserved for internal use.`
  )
  invariant(
    !name.endsWith(`FilterInput`) && !name.endsWith(`SortInput`),
    `GraphQL type names ending with "FilterInput" or "SortInput" are ` +
      `reserved for internal use. Please rename \`${name}\`.`
  )
  invariant(
    ![`Boolean`, `Date`, `Float`, `ID`, `Int`, `JSON`, `String`].includes(name),
    `The GraphQL type \`${name}\` is reserved for internal use by ` +
      `built-in scalar types.`
  )
  assertValidName(name)
}

const createTypeComposerFromGatsbyType = ({
  schemaComposer,
  type,
  parentSpan,
}) => {
  switch (type.kind) {
    case GatsbyGraphQLTypeKind.OBJECT: {
      return ObjectTypeComposer.createTemp(
        {
          ...type.config,
          interfaces: () => {
            if (type.config.interfaces) {
              return type.config.interfaces.map(iface => {
                if (typeof iface === `string`) {
                  return schemaComposer.getIFTC(iface).getType()
                } else {
                  return iface
                }
              })
            } else {
              return []
            }
          },
        },
        schemaComposer
      )
    }
    case GatsbyGraphQLTypeKind.INPUT_OBJECT: {
      return InputTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.UNION: {
      return UnionTypeComposer.createTemp(
        {
          ...type.config,
          types: () => {
            if (type.config.types) {
              return type.config.types.map(typeName =>
                schemaComposer.getOTC(typeName).getType()
              )
            } else {
              return []
            }
          },
        },
        schemaComposer
      )
    }
    case GatsbyGraphQLTypeKind.INTERFACE: {
      return InterfaceTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.ENUM: {
      return EnumTypeComposer.createTemp(type.config, schemaComposer)
    }
    case GatsbyGraphQLTypeKind.SCALAR: {
      return ScalarTypeComposer.createTemp(type.config, schemaComposer)
    }
    default: {
      report.warn(`Illegal type definition: ${JSON.stringify(type.config)}`)
      return null
    }
  }
}

const addSetFieldsOnGraphQLNodeTypeFields = ({ schemaComposer, parentSpan }) =>
  Promise.all(
    Array.from(schemaComposer.values()).map(async tc => {
      if (tc instanceof ObjectTypeComposer && tc.hasInterface(`Node`)) {
        const typeName = tc.getTypeName()
        const result = await apiRunner(`setFieldsOnGraphQLNodeType`, {
          type: {
            name: typeName,
            nodes: getNodesByType(typeName),
          },
          traceId: `initial-setFieldsOnGraphQLNodeType`,
          parentSpan,
        })
        if (result) {
          // NOTE: `setFieldsOnGraphQLNodeType` only allows setting
          // nested fields with a path as property name, i.e.
          // `{ 'frontmatter.published': 'Boolean' }`, but not in the form
          // `{ frontmatter: { published: 'Boolean' }}`
          result.forEach(fields => tc.addNestedFields(fields))
        }
      }
    })
  )

const addThirdPartySchemas = ({
  schemaComposer,
  thirdPartySchemas,
  parentSpan,
}) => {
  thirdPartySchemas.forEach(schema => {
    const schemaQueryType = schema.getQueryType()
    const queryTC = schemaComposer.createTempTC(schemaQueryType)
    processThirdPartyTypeFields({ typeComposer: queryTC, schemaQueryType })
    schemaComposer.Query.addFields(queryTC.getFields())

    // Explicitly add the third-party schema's types, so they can be targeted
    // in `createResolvers` API.
    const types = schema.getTypeMap()
    Object.keys(types).forEach(typeName => {
      const type = types[typeName]
      if (
        type !== schemaQueryType &&
        !isSpecifiedScalarType(type) &&
        !isIntrospectionType(type) &&
        type.name !== `Date` &&
        type.name !== `JSON`
      ) {
        const typeComposer = schemaComposer.createTC(type)
        if (
          typeComposer instanceof ObjectTypeComposer ||
          typeComposer instanceof InterfaceTypeComposer
        ) {
          processThirdPartyTypeFields({ typeComposer, schemaQueryType })
        }
        typeComposer.setExtension(`createdFrom`, `thirdPartySchema`)
        schemaComposer.addSchemaMustHaveType(typeComposer)
      }
    })
  })
}

const resetOverriddenThirdPartyTypeFields = ({ typeComposer }) => {
  // The problem: createResolvers API mutates third party schema instance.
  //   For example it can add a new field referencing a type from our main schema
  //   Then if we rebuild the schema this old type instance will sneak into
  //   the new schema and produce the famous error:
  //   "Schema must contain uniquely named types but contains multiple types named X"
  // This function only affects schema rebuilding pathway.
  //   It cleans up artifacts created by the `createResolvers` API of the previous build
  //   so that we return the third party schema to its initial state (hence can safely re-add)
  // TODO: the right way to fix this would be not to mutate the third party schema in
  //   the first place. But unfortunately mutation happens in the `graphql-compose`
  //   and we don't have an easy way to avoid it without major rework
  typeComposer.getFieldNames().forEach(fieldName => {
    const createdFrom = typeComposer.getFieldExtension(fieldName, `createdFrom`)
    if (createdFrom === `createResolvers`) {
      typeComposer.removeField(fieldName)
      return
    }
    const config = typeComposer.getFieldExtension(
      fieldName,
      `originalFieldConfig`
    )
    if (config) {
      typeComposer.removeField(fieldName)
      typeComposer.addFields({
        [fieldName]: config,
      })
    }
  })
}

const processThirdPartyTypeFields = ({ typeComposer, schemaQueryType }) => {
  resetOverriddenThirdPartyTypeFields({ typeComposer })

  // Fix for types that refer to Query. Thanks Relay Classic!
  typeComposer.getFieldNames().forEach(fieldName => {
    // Remove customization that we could have added via `createResolvers`
    // to make it work with schema rebuilding
    const field = typeComposer.getField(fieldName)
    const fieldType = field.type.toString()
    if (fieldType.replace(/[[\]!]/g, ``) === schemaQueryType.name) {
      typeComposer.extendField(fieldName, {
        type: fieldType.replace(schemaQueryType.name, `Query`),
      })
    }
  })
}

const addCustomResolveFunctions = async ({ schemaComposer, parentSpan }) => {
  const intermediateSchema = schemaComposer.buildSchema()
  const createResolvers = (
    resolvers,
    { ignoreNonexistentTypes = false } = {}
  ) => {
    Object.keys(resolvers).forEach(typeName => {
      const fields = resolvers[typeName]
      if (schemaComposer.has(typeName)) {
        const tc = schemaComposer.getOTC(typeName)
        Object.keys(fields).forEach(fieldName => {
          const fieldConfig = fields[fieldName]
          if (tc.hasField(fieldName)) {
            const originalFieldConfig = tc.getFieldConfig(fieldName)
            const originalTypeName = originalFieldConfig.type.toString()
            const originalResolver = originalFieldConfig.resolve
            let fieldTypeName
            if (fieldConfig.type) {
              fieldTypeName = Array.isArray(fieldConfig.type)
                ? stringifyArray(fieldConfig.type)
                : fieldConfig.type.toString()
            }

            if (
              !fieldTypeName ||
              fieldTypeName.replace(/!/g, ``) ===
                originalTypeName.replace(/!/g, ``) ||
              tc.getExtension(`createdFrom`) === `thirdPartySchema`
            ) {
              const newConfig = {}
              if (fieldConfig.type) {
                newConfig.type = fieldConfig.type
              }
              if (fieldConfig.args) {
                newConfig.args = fieldConfig.args
              }
              if (fieldConfig.resolve) {
                newConfig.resolve = (source, args, context, info) =>
                  fieldConfig.resolve(source, args, context, {
                    ...info,
                    originalResolver:
                      originalResolver || context.defaultFieldResolver,
                  })
                tc.extendFieldExtensions(fieldName, {
                  needsResolve: true,
                })
              }
              tc.extendField(fieldName, newConfig)

              // See resetOverriddenThirdPartyTypeFields for explanation
              if (tc.getExtension(`createdFrom`) === `thirdPartySchema`) {
                tc.setFieldExtension(
                  fieldName,
                  `originalFieldConfig`,
                  originalFieldConfig
                )
              }
            } else if (fieldTypeName) {
              report.warn(
                `\`createResolvers\` passed resolvers for field ` +
                  `\`${typeName}.${fieldName}\` with type \`${fieldTypeName}\`. ` +
                  `Such a field with type \`${originalTypeName}\` already exists ` +
                  `on the type. Use \`createTypes\` to override type fields.`
              )
            }
          } else {
            tc.addFields({
              [fieldName]: fieldConfig,
            })
            // See resetOverriddenThirdPartyTypeFields for explanation
            tc.setFieldExtension(fieldName, `createdFrom`, `createResolvers`)
          }
        })
      } else if (!ignoreNonexistentTypes) {
        report.warn(
          `\`createResolvers\` passed resolvers for type \`${typeName}\` that ` +
            `doesn't exist in the schema. Use \`createTypes\` to add the type ` +
            `before adding resolvers.`
        )
      }
    })
  }
  await apiRunner(`createResolvers`, {
    intermediateSchema,
    createResolvers,
    traceId: `initial-createResolvers`,
    parentSpan,
  })
}

function attachTracingResolver({ schemaComposer }) {
  schemaComposer.forEach(typeComposer => {
    if (
      typeComposer instanceof ObjectTypeComposer ||
      typeComposer instanceof InterfaceTypeComposer
    ) {
      typeComposer.getFieldNames().forEach(fieldName => {
        const field = typeComposer.getField(fieldName)
        typeComposer.extendField(fieldName, {
          resolve: field.resolve
            ? wrappingResolver(field.resolve)
            : defaultResolver,
        })
      })
    }
  })
}

const determineSearchableFields = ({ schemaComposer, typeComposer }) => {
  typeComposer.getFieldNames().forEach(fieldName => {
    const field = typeComposer.getField(fieldName)
    const extensions = typeComposer.getFieldExtensions(fieldName)
    if (field.resolve) {
      if (extensions.dateformat) {
        typeComposer.extendFieldExtensions(fieldName, {
          searchable: SEARCHABLE_ENUM.SEARCHABLE,
          sortable: SORTABLE_ENUM.SORTABLE,
          needsResolve: extensions.proxy ? true : false,
        })
      } else if (!_.isEmpty(field.args)) {
        typeComposer.extendFieldExtensions(fieldName, {
          searchable: SEARCHABLE_ENUM.DEPRECATED_SEARCHABLE,
          sortable: SORTABLE_ENUM.DEPRECATED_SORTABLE,
          needsResolve: true,
        })
      } else {
        typeComposer.extendFieldExtensions(fieldName, {
          searchable: SEARCHABLE_ENUM.SEARCHABLE,
          sortable: SORTABLE_ENUM.SORTABLE,
          needsResolve: true,
        })
      }
    } else {
      typeComposer.extendFieldExtensions(fieldName, {
        searchable: SEARCHABLE_ENUM.SEARCHABLE,
        sortable: SORTABLE_ENUM.SORTABLE,
        needsResolve: false,
      })
    }
  })
}

const addConvenienceChildrenFields = ({ schemaComposer }) => {
  const parentTypesToChildren = new Map()
  const mimeTypesToChildren = new Map()
  const typesHandlingMimeTypes = new Map()

  schemaComposer.forEach(type => {
    if (
      (type instanceof ObjectTypeComposer ||
        type instanceof InterfaceTypeComposer) &&
      type.hasExtension(`mimeTypes`)
    ) {
      const { types } = type.getExtension(`mimeTypes`)
      new Set(types).forEach(mimeType => {
        if (!typesHandlingMimeTypes.has(mimeType)) {
          typesHandlingMimeTypes.set(mimeType, new Set())
        }
        typesHandlingMimeTypes.get(mimeType).add(type)
      })
    }

    if (
      (type instanceof ObjectTypeComposer ||
        type instanceof InterfaceTypeComposer) &&
      type.hasExtension(`childOf`)
    ) {
      if (type instanceof ObjectTypeComposer && !type.hasInterface(`Node`)) {
        report.error(
          `The \`childOf\` extension can only be used on types that implement the \`Node\` interface.\n` +
            `Check the type definition of \`${type.getTypeName()}\`.`
        )
        return
      }
      if (
        type instanceof InterfaceTypeComposer &&
        !type.hasExtension(`nodeInterface`)
      ) {
        report.error(
          `The \`childOf\` extension can only be used on interface types that ` +
            `have the \`@nodeInterface\` extension.\n` +
            `Check the type definition of \`${type.getTypeName()}\`.`
        )
        return
      }

      const { types, mimeTypes, many } = type.getExtension(`childOf`)
      new Set(types).forEach(parentType => {
        if (!parentTypesToChildren.has(parentType)) {
          parentTypesToChildren.set(parentType, new Map())
        }
        parentTypesToChildren.get(parentType).set(type, many)
      })
      new Set(mimeTypes).forEach(mimeType => {
        if (!mimeTypesToChildren.has(mimeType)) {
          mimeTypesToChildren.set(mimeType, new Map())
        }
        mimeTypesToChildren.get(mimeType).set(type, many)
      })
    }
  })

  parentTypesToChildren.forEach((children, parent) => {
    if (!schemaComposer.has(parent)) return
    const typeComposer = schemaComposer.getAnyTC(parent)
    if (
      typeComposer instanceof InterfaceTypeComposer &&
      !typeComposer.hasExtension(`nodeInterface`)
    ) {
      report.error(
        `With the \`childOf\` extension, children fields can only be added to ` +
          `interfaces which have the \`@nodeInterface\` extension.\n` +
          `Check the type definition of \`${typeComposer.getTypeName()}\`.`
      )
      return
    }
    children.forEach((many, child) => {
      if (many) {
        typeComposer.addFields(createChildrenField(child.getTypeName()))
      } else {
        typeComposer.addFields(createChildField(child.getTypeName()))
      }
    })
  })

  mimeTypesToChildren.forEach((children, mimeType) => {
    const parentTypes = typesHandlingMimeTypes.get(mimeType)
    if (parentTypes) {
      parentTypes.forEach(typeComposer => {
        if (
          typeComposer instanceof InterfaceTypeComposer &&
          !typeComposer.hasExtension(`nodeInterface`)
        ) {
          report.error(
            `With the \`childOf\` extension, children fields can only be added to ` +
              `interfaces which have the \`@nodeInterface\` extension.\n` +
              `Check the type definition of \`${typeComposer.getTypeName()}\`.`
          )
          return
        }
        children.forEach((many, child) => {
          if (many) {
            typeComposer.addFields(createChildrenField(child.getTypeName()))
          } else {
            typeComposer.addFields(createChildField(child.getTypeName()))
          }
        })
      })
    }
  })
}

const addImplicitConvenienceChildrenFields = ({
  schemaComposer,
  typeComposer,
}) => {
  const shouldInfer = typeComposer.getExtension(`infer`)
  // In Gatsby v3, when `@dontInfer` is set, children fields will not be
  // created for parent-child relations set by plugins with
  // `createParentChildLink`. With `@dontInfer`, only parent-child
  // relations explicitly set with the `childOf` extension will be added.
  // if (shouldInfer === false) return

  const parentTypeName = typeComposer.getTypeName()
  const nodes = getNodesByType(parentTypeName)

  const childNodesByType = groupChildNodesByType({ nodes })

  Object.keys(childNodesByType).forEach(typeName => {
    const typeChildren = childNodesByType[typeName]
    const maxChildCount = _.maxBy(
      _.values(_.groupBy(typeChildren, c => c.parent)),
      g => g.length
    ).length

    // Adding children fields to types with the `@dontInfer` extension is deprecated
    if (shouldInfer === false) {
      const childTypeComposer = schemaComposer.getAnyTC(typeName)
      const childOfExtension = childTypeComposer.getExtension(`childOf`)
      const many = maxChildCount > 1

      // Only warn when the parent-child relation has not been explicitly set with
      if (
        !childOfExtension ||
        !childOfExtension.types.includes(parentTypeName) ||
        !childOfExtension.many === many
      ) {
        const fieldName = many
          ? fieldNames.convenienceChildren(typeName)
          : fieldNames.convenienceChild(typeName)
        report.warn(
          `The type \`${parentTypeName}\` does not explicitly define ` +
            `the field \`${fieldName}\`.\n` +
            `On types with the \`@dontInfer\` directive, or with the \`infer\` ` +
            `extension set to \`false\`, automatically adding fields for ` +
            `children types is deprecated.\n` +
            `In Gatsby v3, only children fields explicitly set with the ` +
            `\`childOf\` extension will be added.\n`
        )
      }
    }

    if (maxChildCount > 1) {
      typeComposer.addFields(createChildrenField(typeName))
    } else {
      typeComposer.addFields(createChildField(typeName))
    }
  })
}

const createChildrenField = typeName => {
  return {
    [fieldNames.convenienceChildren(typeName)]: {
      type: () => [typeName],
      resolve(source, args, context) {
        const { path } = context
        return context.nodeModel.getNodesByIds(
          { ids: source.children, type: typeName },
          { path }
        )
      },
    },
  }
}

const createChildField = typeName => {
  return {
    [fieldNames.convenienceChild(typeName)]: {
      type: () => typeName,
      async resolve(source, args, context) {
        const { path } = context
        const result = await context.nodeModel.getNodesByIds(
          { ids: source.children, type: typeName },
          { path }
        )
        if (result && result.length > 0) {
          return result[0]
        } else {
          return null
        }
      },
    },
  }
}

const groupChildNodesByType = ({ nodes }) =>
  _(nodes)
    .flatMap(node => (node.children || []).map(getNode).filter(Boolean))
    .groupBy(node => (node.internal ? node.internal.type : undefined))
    .value()

const addTypeToRootQuery = ({ schemaComposer, typeComposer }) => {
  const sortInputTC = getSortInput({
    schemaComposer,
    typeComposer,
  })
  const filterInputTC = getFilterInput({
    schemaComposer,
    typeComposer,
  })
  const paginationTC = getPagination({
    schemaComposer,
    typeComposer,
  })

  const typeName = typeComposer.getTypeName()
  // not strictly correctly, result is `npmPackage` and `allNpmPackage` from type `NPMPackage`
  const queryName = fieldNames.query(typeName)
  const queryNamePlural = fieldNames.queryAll(typeName)

  schemaComposer.Query.addFields({
    [queryName]: {
      type: typeComposer,
      args: {
        ...filterInputTC.getFields(),
      },
      resolve: findOne(typeName),
    },
    [queryNamePlural]: {
      type: paginationTC,
      args: {
        filter: filterInputTC,
        sort: sortInputTC,
        skip: `Int`,
        limit: `Int`,
      },
      resolve: findManyPaginated(typeName),
    },
  }).makeFieldNonNull(queryNamePlural)
}

const parseTypes = ({
  doc,
  plugin,
  createdFrom,
  schemaComposer,
  parentSpan,
}) => {
  const types = []
  doc.definitions.forEach(def => {
    const name = def.name.value
    checkIsAllowedTypeName(name)

    if (schemaComposer.has(name)) {
      // We don't check if ast.kind matches composer type, but rely
      // that this will throw when something is wrong and get
      // reported by `reportParsingError`.

      // Keep the original type composer around
      const typeComposer = schemaComposer.get(name)

      // After this, the parsed type composer will be registered as the composer
      // handling the type name
      const parsedType = schemaComposer.typeMapper.makeSchemaDef(def)

      // Merge the parsed type with the original
      mergeTypes({
        schemaComposer,
        typeComposer,
        type: parsedType,
        plugin,
        createdFrom,
        parentSpan,
      })

      // Set the original type composer (with the merged fields added)
      // as the correct composer for the type name
      schemaComposer.typeMapper.set(typeComposer.getTypeName(), typeComposer)
    } else {
      const parsedType = schemaComposer.typeMapper.makeSchemaDef(def)
      types.push(parsedType)
    }
  })
  return types
}

const stringifyArray = arr =>
  `[${arr.map(item =>
    Array.isArray(item) ? stringifyArray(item) : item.toString()
  )}]`

// TODO: Import this directly from graphql-compose once we update to v7
const isNamedTypeComposer = type =>
  type instanceof ObjectTypeComposer ||
  type instanceof InputTypeComposer ||
  type instanceof ScalarTypeComposer ||
  type instanceof EnumTypeComposer ||
  type instanceof InterfaceTypeComposer ||
  type instanceof UnionTypeComposer

const validate = (type, value) => {
  if (type instanceof GraphQLNonNull) {
    if (value == null) {
      throw new Error(`Expected non-null field value.`)
    }
    return validate(type.ofType, value)
  } else if (type instanceof GraphQLList) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array field value.`)
    }
    return value.map(v => validate(type.ofType, v))
  } else {
    return type.parseValue(value)
  }
}

const checkQueryableInterfaces = ({ schemaComposer }) => {
  const queryableInterfaces = new Set()
  schemaComposer.forEach(type => {
    if (
      type instanceof InterfaceTypeComposer &&
      type.getExtension(`nodeInterface`)
    ) {
      queryableInterfaces.add(type.getTypeName())
    }
  })
  const incorrectTypes = []
  schemaComposer.forEach(type => {
    if (type instanceof ObjectTypeComposer) {
      const interfaces = type.getInterfaces()
      if (
        interfaces.some(iface => queryableInterfaces.has(iface.name)) &&
        !type.hasInterface(`Node`)
      ) {
        incorrectTypes.push(type.getTypeName())
      }
    }
  })
  if (incorrectTypes.length) {
    report.panic(
      `Interfaces with the \`nodeInterface\` extension must only be ` +
        `implemented by types which also implement the \`Node\` ` +
        `interface. Check the type definition of ` +
        `${incorrectTypes.map(t => `\`${t}\``).join(`, `)}.`
    )
  }
}

const mergeFields = ({ typeComposer, fields }) =>
  Object.entries(fields).forEach(([fieldName, fieldConfig]) => {
    if (typeComposer.hasField(fieldName)) {
      typeComposer.extendField(fieldName, fieldConfig)
    } else {
      typeComposer.setField(fieldName, fieldConfig)
    }
  })
