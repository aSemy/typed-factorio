import { assertNever, getFirst, sortByOrder } from "../util"
import ts from "typescript"
import { Attribute, CallOperator, Class, IndexOperator, LengthOperator, Method, Parameter } from "../FactorioApiJson"
import { addFakeJSDoc, makeNullable, Modifiers, removeLuaPrefix, Tokens, toPascalCase, Types } from "../genUtil"
import { getAnnotations, InterfaceDef, TypeAliasDef } from "../manualDefinitions"
import DefinitionsGenerator, { Statements } from "../DefinitionsGenerator"

export function preprocessClasses(generator: DefinitionsGenerator) {
  for (const clazz of generator.apiDocs.classes) {
    generator.typeNames[clazz.name] = clazz.name

    const existing = generator.manualDefinitions[clazz.name]
    if (existing && existing.kind !== "interface" && existing.kind !== "type") {
      throw new Error("Manual define for class should be interface or type alias")
    }
    for (const method of clazz.methods) {
      analyzeMethod(generator, method)
    }
    for (const attribute of clazz.attributes) {
      analyzeAttribute(generator, attribute)
    }
    for (const operator of clazz.operators) {
      if (operator.name === "call") {
        analyzeMethod(generator, operator)
      } else {
        analyzeAttribute(generator, operator)
      }
    }
  }
}

function analyzeMethod(generator: DefinitionsGenerator, method: Method) {
  for (const parameter of method.parameters) {
    generator.mapTypeBasic(parameter.type, false, true)
  }
  if (method.variant_parameter_groups) {
    for (const parameter of method.variant_parameter_groups.flatMap((x) => x.parameters)) {
      generator.mapTypeBasic(parameter.type, false, true)
    }
  }
  if (method.variadic_type) {
    generator.mapTypeBasic(method.variadic_type, false, true)
  }
  for (const returnValue of method.return_values) {
    generator.mapTypeBasic(returnValue.type, true, false)
  }
}

function analyzeAttribute(generator: DefinitionsGenerator, attribute: Attribute) {
  generator.mapTypeBasic(attribute.type, attribute.read, attribute.write)
}

export function generateClasses(generator: DefinitionsGenerator) {
  const statements = generator.newStatements()

  for (const clazz of generator.apiDocs.classes.sort(sortByOrder)) {
    const existing = generator.manualDefinitions[clazz.name]
    if (existing && existing.kind !== "interface" && existing.kind !== "type") {
      throw new Error("Manual define for class should be interface or type alias")
    }
    generateClass(generator, clazz, existing, statements)
  }

  generator.addFile("classes", statements)
}

interface MemberAndOriginal {
  original: Method | Attribute
  member: ts.TypeElement | ts.TypeElement[]
}

function generateClass(
  generator: DefinitionsGenerator,
  clazz: Class,
  existing: InterfaceDef | TypeAliasDef | undefined,
  statements: Statements
) {
  const superTypes = getSupertypes()
  const arrayType = getArrayType()

  const members: MemberAndOriginal[] = []
  // methods + operators
  fillMembersAndOperators()
  const indexType = fillIndexType()
  // attributes
  fillAttributes()
  shiftLuaObjectMembers()
  let discriminantProperty: string | undefined, membersBySubclass: Map<string, MemberAndOriginal[]>
  processSubclasses()
  generateDeclarations()

  function getSupertypes() {
    const supertypes: ts.ExpressionWithTypeArguments[] = []
    if (clazz.base_classes) {
      supertypes.push(
        ...clazz.base_classes.map((b) =>
          ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier(b), undefined)
        )
      )
    }
    if (existing) {
      if (existing.kind === "interface") {
        supertypes.push(...existing.supertypes)
      } else if (existing.kind === "type") {
        supertypes.push(
          ...existing.supertypes.map((t) =>
            ts.isTypeReferenceNode(t)
              ? ts.factory.createExpressionWithTypeArguments(t.typeName as ts.Identifier, t.typeArguments)
              : t
          )
        )
      } else {
        assertNever(existing)
      }
    }
    return supertypes
  }

  function getArrayType() {
    if (existing?.kind !== "interface") return
    const arrayExtend = existing.supertypes.find(
      (t) => ts.isIdentifier(t.expression) && (t.expression.text === "Array" || t.expression.text === "ReadonlyArray")
    )
    if (!arrayExtend) return
    const type = arrayExtend.typeArguments?.[0]
    const readonly = (arrayExtend.expression as ts.Identifier).text === "ReadonlyArray"
    if (!type) throw new Error(`Manual define ${clazz.name} extends an array type without type arguments`)
    return { type, readonly }
  }

  function fillIndexType() {
    const indexOperator = clazz.operators.find((x) => x.name === "index") as IndexOperator | undefined
    if (!indexOperator) return
    if (arrayType) {
      const indexSignature = generator.addJsDoc(
        ts.factory.createIndexSignature(
          undefined,
          arrayType.readonly ? [Modifiers.readonly] : undefined,
          [
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              undefined,
              "index",
              undefined,
              Types.number,
              undefined
            ),
          ],
          arrayType.type
        ),
        indexOperator,
        clazz.name + ".operator%20[]"
      )
      members.push({ original: indexOperator, member: indexSignature })
      return
    }
    if (!(existing?.kind === "type" && existing.indexOperator)) {
      generator.warnIncompleteDefinition("No index operator manual definition for class", clazz.name)
      return
    }

    const existingIndexOp = existing.indexOperator
    const shortName = removeLuaPrefix(clazz.name)
    if (ts.isMappedTypeNode(existingIndexOp)) {
      return ts.factory.createTypeAliasDeclaration(
        undefined,
        undefined,
        shortName + "Index",
        existing.node.typeParameters,
        generator.addJsDoc(existingIndexOp, indexOperator, clazz.name + ".operator%20[]")
      )
    }
    if (ts.isTypeLiteralNode(existingIndexOp)) {
      const indexSignature = generator.addJsDoc(
        existingIndexOp.members[0] as ts.IndexSignatureDeclaration,
        indexOperator,
        clazz.name + ".operator%20[]"
      )
      return ts.factory.createInterfaceDeclaration(undefined, undefined, shortName + "Index", undefined, undefined, [
        indexSignature,
      ])
    }
    assertNever(existingIndexOp)
  }

  function fillMembersAndOperators() {
    members.push(
      ...clazz.methods.sort(sortByOrder).map((method) => ({
        original: method,
        member: mapMethod(method),
      }))
    )

    const callOperator = clazz.operators.find((x) => x.name === "call") as CallOperator | undefined
    if (callOperator) {
      // manual define for operator not supported yet
      const asMethod = mapMethod({
        ...callOperator,
        name: "operator%20()",
      }) as ts.MethodSignature
      const callSignature = ts.factory.createCallSignature(undefined, asMethod.parameters, asMethod.type)
      ts.setSyntheticLeadingComments(callSignature, ts.getSyntheticLeadingComments(asMethod))
      members.push({ original: callOperator, member: callSignature })
    }

    const lengthOperator = clazz.operators.find((x) => x.name === "length") as LengthOperator | undefined
    if (lengthOperator) {
      // length operator is (supposed to be) numeric, so not map with transforms
      const type = generator.mapTypeBasic(lengthOperator.type, true, false).read
      const lengthProperty = generator.addJsDoc(
        ts.factory.createPropertySignature(
          [Modifiers.readonly],
          "length",
          undefined,
          arrayType ? type : ts.factory.createTypeReferenceNode("LuaLengthMethod", [type])
        ),
        lengthOperator,
        clazz.name + ".operator%20#"
      )
      members.push({ original: lengthOperator, member: lengthProperty })
    }
  }

  function fillAttributes() {
    members.push(
      ...clazz.attributes.sort(sortByOrder).map((attr) => ({
        original: attr,
        member: generator.mapAttribute(attr, clazz.name, existing),
      }))
    )
  }

  function shiftLuaObjectMembers() {
    const standardMembers: {
      valid?: { original: Attribute; member: ts.PropertySignature }
      object_name?: { original: Attribute; member: ts.PropertySignature }
      help?: { original: Method; member: ts.MethodSignature }
    } = {}
    for (let i = 0; i < members.length; i++) {
      const group = members[i]
      const member = group.member
      if (Array.isArray(member)) continue
      if (!member.name || !ts.isIdentifier(member.name)) continue
      const name = member.name.text
      if (name === "valid" || name === "object_name" || name === "help") {
        standardMembers[name] = group as never
        members.splice(i, 1)
        i--
      }
    }

    function setNoRefJsDoc(property: { original: Attribute | Method; member: ts.TypeElement }) {
      ts.setSyntheticLeadingComments(property.member, undefined)
      generator.addJsDoc(property.member, property.original, undefined)
    }

    if (standardMembers.valid) {
      const property = standardMembers.valid
      setNoRefJsDoc(property)
      members.push(standardMembers.valid)
    }

    if (standardMembers.object_name) {
      const attribute = standardMembers.object_name
      const member = attribute.member
      setNoRefJsDoc(attribute)
      if (!clazz.description.match(/abstract/i)) {
        attribute.member = ts.factory.updatePropertySignature(
          member,
          member.modifiers,
          member.name,
          member.questionToken,
          Types.stringLiteral(clazz.name)
        )
      }
      members.push(standardMembers.object_name)
    }

    if (standardMembers.help) {
      const property = standardMembers.help
      setNoRefJsDoc(property)
      members.push(standardMembers.help)
    }
  }

  function processSubclasses() {
    /// hardcoded for now
    if (clazz.name === "LuaRendering") return
    type MapName = string & { _mapNameBrand: never }
    type UseName = string & { _useNameBrand: never }

    let getMapName: (name: string) => MapName
    function normalizeName(origName: string) {
      return origName.replace(/[-_ ]/g, "").toLowerCase() as MapName
    }
    const mapMembersBySubclass = new Map<MapName, MemberAndOriginal[]>()
    const useNames = new Map<MapName, UseName>()

    discriminantProperty = existing?.annotations.discriminatedUnion?.[0]
    if (discriminantProperty) {
      const property = members.find((m) => m.original.name === discriminantProperty)
      if (property === undefined) {
        throw new Error(`Discriminant property ${discriminantProperty} was not found on ${clazz.name}`)
      }
      const memberNode = property.member
      if (Array.isArray(memberNode) || !ts.isPropertySignature(memberNode)) {
        throw new Error(`Discriminant property ${clazz.name}.${discriminantProperty} should be a property signature`)
      }
      const types = generator.tryGetStringEnumType(memberNode.type!)
      if (!types) {
        throw new Error(`Discriminant property ${clazz.name}.${discriminantProperty} is not a string literal union`)
      }

      getMapName = normalizeName
      for (const type of types) {
        const mapName = getMapName(type)
        useNames.set(mapName, toPascalCase(type) as UseName)
        mapMembersBySubclass.set(mapName, [
          {
            member: ts.factory.updatePropertySignature(
              memberNode,
              memberNode.modifiers,
              memberNode.name,
              memberNode.questionToken,
              Types.stringLiteral(type)
            ),
            original: property.original,
          },
        ])
      }
    } else {
      const words = clazz.name.match(/($[a-z])|[A-Z][a-z]+/g)!.reverse()

      function trimName(name: string) {
        name = removeLuaPrefix(name)
        for (const word of words) {
          if (name.endsWith(word)) name = name.substring(0, name.length - word.length)
        }
        return name
      }
      getMapName = (name: string) => normalizeName(trimName(name))

      for (const memberAndOriginal of members) {
        const subclasses = getSubclasses(memberAndOriginal.original)
        if (!subclasses) continue
        for (const subclass of subclasses) {
          const baseName = trimName(subclass)
          const mapName = normalizeName(baseName)
          const existingUseName = useNames.get(mapName)
          const useName = toPascalCase(baseName) as UseName
          if (existingUseName !== undefined) {
            if (useName !== existingUseName) {
              throw new Error(`Multiple derived names for ${subclass} (${mapName}): ${existingUseName}, ${useName}`)
            }
          } else {
            useNames.set(mapName, useName)
            mapMembersBySubclass.set(mapName, [])
          }
        }
      }
      if (mapMembersBySubclass.size <= 1) return {}
    }

    mapMembersBySubclass.set("" as MapName, [])
    useNames.set("" as MapName, "" as UseName)

    // const ignoreSubclasses = new Set(existing.annotations.ignoreSubclasses)

    for (const memberAndOriginal of members) {
      const { original } = memberAndOriginal
      const subclasses = getSubclasses(original)
      if (!subclasses) {
        mapMembersBySubclass.get("" as MapName)!.push(memberAndOriginal)
        continue
      }
      for (const subclass of subclasses) {
        const mapName = getMapName(subclass)
        const subclassMembers = mapMembersBySubclass.get(mapName)
        if (subclassMembers === undefined) {
          // if (ignoreSubclasses.has(mapName)) continue
          throw new Error(
            `Subclass restriction ${subclass} (${mapName}) for ${clazz.name}.${
              original.name
            } does not fit subclass types: ${Array.from(mapMembersBySubclass.keys())}`
          )
        }
        subclassMembers.push(memberAndOriginal)
      }
    }

    membersBySubclass = new Map(
      Array.from(mapMembersBySubclass.entries()).map(([mapName, v]) => [useNames.get(mapName)!, v])
    )

    function getSubclasses(member: Method | Attribute): string[] | undefined {
      const existingMember = existing?.members[member.name]?.[0]
      return (existingMember && getAnnotations(existingMember as ts.JSDocContainer).subclasses) ?? member.subclasses
    }
  }

  function createDeclaration(
    name: string,
    thisSupertypes: ts.ExpressionWithTypeArguments[],
    thisMembers: MemberAndOriginal[],
    indexTypeName: string | undefined,
    classForDocs: Class | undefined
  ) {
    const baseSupertypes: ts.ExpressionWithTypeArguments[] = thisSupertypes.filter((x) => !x.typeArguments)
    const declarationSupertypes: ts.ExpressionWithTypeArguments[] = thisSupertypes.filter((x) => x.typeArguments)
    if (!indexTypeName) baseSupertypes.push(...declarationSupertypes)

    const baseDeclaration = ts.factory.createInterfaceDeclaration(
      undefined,
      undefined,
      indexTypeName ? name + "Members" : name,
      indexTypeName ? undefined : existing?.node.typeParameters,
      baseSupertypes.length !== 0
        ? [ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, baseSupertypes)]
        : undefined,
      thisMembers.flatMap((m) => m.member)
    )
    statements.add(baseDeclaration)

    if (!indexTypeName) {
      if (classForDocs) {
        generator.addJsDoc(
          baseDeclaration,
          classForDocs,
          classForDocs.name,
          needsNoSelfAnnotation(baseDeclaration) ? [noSelfAnnotation] : []
        )
      } else {
        addNoSelfAnnotationOnly(baseDeclaration)
      }
    } else {
      addNoSelfAnnotationOnly(baseDeclaration)
      const typeArguments = existing?.node.typeParameters?.map((p) => ts.factory.createTypeReferenceNode(p.name))
      const declaration = ts.factory.createTypeAliasDeclaration(
        undefined,
        undefined,
        name,
        existing?.node.typeParameters,
        ts.factory.createIntersectionTypeNode([
          ts.factory.createTypeReferenceNode(name + "Members"),
          ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(indexTypeName), typeArguments),
          ...declarationSupertypes,
        ])
      )
      if (classForDocs) {
        generator.addJsDoc(declaration, classForDocs, classForDocs.name)
      }
      statements.add(declaration)
    }
  }

  function generateDeclarations() {
    if (indexType) {
      statements.add(indexType)
    }
    const shortName = removeLuaPrefix(clazz.name)
    const indexTypeName = indexType ? shortName + "Index" : undefined
    if (!membersBySubclass || !discriminantProperty) {
      // if no discriminant property, generate normal class as well as subclasses
      createDeclaration(clazz.name, superTypes, members, indexTypeName, clazz)
    }
    if (!membersBySubclass) return
    const baseName = "Base" + shortName
    createDeclaration(baseName, superTypes, membersBySubclass.get("")!, undefined, undefined)
    const groupSupertypes = [
      ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier(baseName), undefined),
    ]
    for (const [groupName, subclassMembers] of membersBySubclass) {
      if (groupName === "") continue
      createDeclaration(toPascalCase(groupName) + shortName, groupSupertypes, subclassMembers, indexTypeName, undefined)
    }

    const allSubclassTypes = Array.from(membersBySubclass.keys())
      .filter((x) => x !== "")
      .map((subclass) => toPascalCase(subclass) + (indexTypeName ? shortName + "Members" : shortName))
    if (discriminantProperty) {
      // union
      const unionDeclaration = ts.factory.createTypeAliasDeclaration(
        undefined,
        undefined,
        indexTypeName ? shortName + "Members" : clazz.name,
        undefined,
        ts.factory.createUnionTypeNode(allSubclassTypes.map((x) => ts.factory.createTypeReferenceNode(x)))
      )
      if (!indexTypeName) generator.addJsDoc(unionDeclaration, clazz, clazz.name)
      statements.add(unionDeclaration)
    }

    // if (existing?.annotations.generateByTypeIndex) {
    //   const typeMembers = Array.from(subclassesInfo.originalSubclassNames.entries()).map(
    //     ([subclassName, origName]) =>
    //       ts.factory.createPropertySignature(
    //         undefined,
    //         DefinitionsGenerator.escapePropertyName(origName),
    //         undefined,
    //         ts.factory.createTypeReferenceNode(toPascalCase(subclassName) + shortName)
    //       )
    //   )
    //   const outName = shortName + "ByType"
    //   statements.add(
    //     ts.factory.createInterfaceDeclaration(undefined, undefined, outName, undefined, undefined, typeMembers)
    //   )
    //   generator.typeNames[outName] = outName
    // }

    if (indexTypeName) {
      const declaration = ts.factory.createTypeAliasDeclaration(
        undefined,
        undefined,
        clazz.name,
        existing?.node.typeParameters,
        ts.factory.createIntersectionTypeNode([
          ts.factory.createTypeReferenceNode(shortName + "Members"),
          ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(indexTypeName)),
        ])
      )
      generator.addJsDoc(declaration, clazz, clazz.name)
      statements.add(declaration)
    }
  }
  function mapParameterToParameter(parameter: Parameter, parent: string): ts.ParameterDeclaration {
    const type = generator.mapTypeWithTransforms(parameter, parent, parameter.type, false, true).write
    return ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      undefined,
      escapeParameterName(parameter.name),
      parameter.optional ? Tokens.question : undefined,
      type
    )
  }

  function mapMethod(method: Method): ts.MethodSignature[] | ts.MethodSignature {
    const existingMethods = existing?.members[method.name]
    const firstExistingMethod = existingMethods?.[0]
    const thisPath = clazz.name + "." + method.name
    const parameters = method.takes_table
      ? [
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            undefined,
            "params",
            method.table_is_optional ? Tokens.question : undefined,
            method.variant_parameter_groups !== undefined
              ? generator.createVariantParameterTypes(
                  (firstExistingMethod && getAnnotations(firstExistingMethod as ts.JSDocContainer).variantsName?.[0]) ??
                    removeLuaPrefix(clazz.name) + toPascalCase(method.name),
                  method,
                  statements,
                  false,
                  true
                )
              : ts.factory.createTypeLiteralNode(
                  method.parameters
                    .sort(sortByOrder)
                    .map((m) => generator.mapParameterToProperty(m, thisPath, false, true))
                )
          ),
        ]
      : method.parameters.sort(sortByOrder).map((m) => mapParameterToParameter(m, thisPath))

    if (method.variadic_type) {
      const type = generator.mapTypeBasic(
        {
          complex_type: "array",
          value: method.variadic_type,
        },
        false,
        true
      ).write
      parameters.push(
        ts.factory.createParameterDeclaration(undefined, undefined, Tokens.dotDotDot, "args", undefined, type)
      )
    }

    let signatures: ts.MethodSignature[] | ts.MethodSignature

    function mapReturnType(type: Method["return_values"][number]): ts.TypeNode {
      const result = generator.mapTypeWithTransforms(
        {
          ...type,
          name: "<return>",
        },
        thisPath,
        type.type,
        true,
        false
      ).read
      return type.optional ? makeNullable({ read: result }).read! : result
    }

    let returnType: ts.TypeNode
    if (method.return_values.length === 0) {
      returnType = Types.void
    } else if (method.return_values.length === 1) {
      returnType = mapReturnType(method.return_values[0])
    } else {
      const types = method.return_values.map(mapReturnType)
      returnType = ts.factory.createTypeReferenceNode("LuaMultiReturn", [ts.factory.createTupleTypeNode(types)])
    }

    if (existingMethods) {
      existingMethods.forEach((m) => {
        if (!ts.isMethodSignature(m)) {
          throw new Error(
            `Manual define for ${clazz.name}.${method.name} should be a method signature, got ${
              ts.SyntaxKind[m.kind]
            } instead`
          )
        }
      })
      signatures = (existingMethods as ts.MethodSignature[]).map((m) => {
        const member = ts.factory.createMethodSignature(
          m.modifiers,
          m.name,
          m.questionToken,
          m.typeParameters,
          m.parameters.length > 0 ? m.parameters : parameters,
          m.type ?? returnType
        )
        ts.setEmitFlags(member.name, ts.EmitFlags.NoComments)
        return member
      })
    } else {
      signatures = ts.factory.createMethodSignature(
        undefined,
        method.name,
        undefined,
        undefined,
        parameters,
        returnType
      )
    }
    const tags: ts.JSDocTag[] = []
    if (!method.takes_table) {
      tags.push(
        ...(method.parameters as { name: string; description?: string }[])
          .concat([{ name: "args", description: method.variadic_description }])
          .filter((p) => p.description)
          .map((p) =>
            ts.factory.createJSDocParameterTag(
              undefined,
              ts.factory.createIdentifier(escapeParameterName(p.name)),
              false,
              undefined,
              undefined,
              generator.processDescription(p.description)
            )
          )
      )
    }

    if (method.return_values.length === 1) {
      if (method.return_values[0].description)
        tags.push(
          ts.factory.createJSDocReturnTag(
            undefined,
            undefined,
            generator.processDescription(method.return_values[0].description)
          )
        )
    } else if (method.return_values.length > 1) {
      tags.push(
        ...method.return_values.map((r) =>
          ts.factory.createJSDocReturnTag(undefined, undefined, generator.processDescription(r.description))
        )
      )
    }
    generator.addJsDoc(getFirst(signatures), method, thisPath, tags)
    // if (Array.isArray(members)) {
    //   for (let i = 1; i < members.length; i++) {
    //     const member = members[i]
    //     addFakeJSDoc(member, ts.factory.createJSDocComment(`{@inheritDoc ${thisPath}}`))
    //   }
    // }
    return signatures
  }
}

const keywords = new Set(["function", "interface"])
function escapeParameterName(name: string): string {
  if (keywords.has(name)) {
    return "_" + name
  }
  return name
}

const noSelfAnnotation = ts.factory.createJSDocUnknownTag(ts.factory.createIdentifier("noSelf"))
function needsNoSelfAnnotation(node: ts.Node) {
  return ts.isInterfaceDeclaration(node) && node.members.some((m) => ts.isMethodSignature(m))
}

function addNoSelfAnnotationOnly(node: ts.InterfaceDeclaration) {
  if (!needsNoSelfAnnotation(node)) return
  const jsDoc = ts.factory.createJSDocComment(undefined, [noSelfAnnotation])
  addFakeJSDoc(node, jsDoc)
}
