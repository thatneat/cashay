import {ensureRootType} from './utils';
import {
  NAME,
  VARIABLE,
  VARIABLE_DEFINITION,
  NAMED_TYPE,
} from 'graphql/language/kinds';
import {parse} from 'graphql/language/parser';
import {print} from 'graphql/language/printer';

export const createMutationString = function(mutationName, componentIdsToUpdate) {
  const listenerMap = this._listenersByMutation[mutationName];

  // return quickly without needing to save to cache for single components
  if (componentIdsToUpdate.length === 1) {
    return listenerMap.get(componentIdsToUpdate[0]);
  }

  // return quickly without needing to save to cache for multiple components that need the same thing
  const mutationStringSet = makeMutationStringSet(listenerMap, componentIdsToUpdate);
  if (mutationStringSet.size === 1) {
    return listenerMap.get(componentIdsToUpdate[0]);
  }

  // if the components we want are the ones we cached, grab the mutation string from the cache
  const cachedMutationObj = this._cachedMutations[mutationName];
  const cachedMutationString = getCachedMutationString(cachedMutationObj, mutationStringSet);
  if (cachedMutationString) {
    return cachedMutationString;
  }

  // do the super expensive AST parse and merge
  const fullMutation = mergeStringSet(mutationStringSet, this._schema);
  this._cachedMutations[mutationName] = {
    fullMutation,
    setKey: mutationStringSet
  };
  return fullMutation;
};

const makeMutationStringSet = (listenerMap, componentIdsToUpdate) => {
  const mutationStringSet = new Set();
  for (let componentId of componentIdsToUpdate) {
    mutationStringSet.add(listenerMap.get(componentId).mutation);
  }
  return mutationStringSet;
};

const getCachedMutationString = (cachedMutationObj, mutationStringSet) => {
  if (cachedMutationObj && cachedMutationObj.setKey.size === mutationStringSet.size) {
    for (let mutationString of cachedMutationObj.setKey) {
      if (!mutationStringSet.has(mutationString)) {
        return
      }
    }
    return cachedMutationObj.fullMutation;
  }
};

export const mergeStringSet = (mutationStringSet, schema) => {
  const mutationArr = Array.from(mutationStringSet);
  const mutationASTs = mutationArr.map(mutStr => parse(mutStr, {noLocation: true, noSource: true}));
  const mergedAST = mergeMutationASTs(mutationASTs, schema);
  return print(mergedAST);
};

const mergeMutationASTs = (mutationASTs, schema) => {

  // create the base AST
  const mergedAST = mutationASTs.pop();
  const operationDefinition = mergedAST.definitions[0];
  const variableDefinitionBag = operationDefinition.variableDefinitions || [];
  const mutationSelection = operationDefinition.selectionSet.selections[0];
  const operationName = schema.mutationType.name;
  const operationSchema = schema.types.find(type => type.name === operationName);
  const fieldSchema = operationSchema.fields.find(field => field.name === mutationSelection.name.value);
  debugger
  bagArgs(variableDefinitionBag, mutationSelection.arguments, fieldSchema);

  // now add the new ASTs one-by-one
  for (let ast of mutationASTs) {
    mergeNewAST(mergedAST, ast, variableDefinitionBag, fieldSchema, schema);
  }
  return mergedAST;
};

const mergeNewAST = (target, src, variableDefinitionBag, fieldSchema, schema) => {
  const srcMutationSelection = src.definitions[0].selectionSet.selections[0];
  const targetMutationSelection = target.definitions[0].selectionSet.selections[0];
  if (srcMutationSelection.name.value !== targetMutationSelection.name.value) {
    throw new Error(`Cannot merge two different mutations: 
    ${srcMutationSelection.name.value} and ${targetMutationSelection.name.value}.
    Make sure each mutation operation only calls a single mutation 
    and that customMutations don't call a separate mutation.`)
  }
  bagArgs(variableDefinitionBag, srcMutationSelection.arguments, fieldSchema);
  const rootSchemaType = ensureRootType(fieldSchema.type);
  const subSchema = schema.types.find(type => type.name === rootSchemaType.name);
  mergeSelections(targetMutationSelection, srcMutationSelection, variableDefinitionBag, subSchema, schema)
};

const bagArgs = (bag, argsToDefine, fieldSchema) => {
  for (let arg of argsToDefine) {
    if (arg.value.kind === VARIABLE) {
      const variableDefName = arg.value.name.value;
      const variableDefOfArg = bag.find(def => def.variable.name.value === variableDefName);
      if (!variableDefOfArg) {
        const newVariableDef = makeVariableDefinition(variableDefName, fieldSchema);
        bag.push(newVariableDef);
      }
    }
  }
};

const mergeSelections = (target, src, bag, fieldSchema, schema) => {
  if (!target.selectionSet) {
    target.selectionSet = src.selectionSet;
  } else if (src.selectionSet) {
    const targetSelections = target.selectionSet.selections;
    const srcSelections = src.selectionSet.selections;
    for (let srcSelection of srcSelections) {
      const matchingValue = targetSelections.find(targetSelection => targetSelection.name.value === srcSelection.name.value);
      if (matchingValue) {
        const field = fieldSchema.fields.find(field => field.name === matchingValue.name.value);
        const rootFieldSchemaType = ensureRootType(field.type);
        const subSchema = schema.types.find(type => type.name === rootFieldSchemaType.name);
        mergeSelections(matchingValue, srcSelection, bag, subSchema, schema);
      } else {
        targetSelections.push(srcSelection);
      }
    }
  }
  if (src.arguments) {
    bagArgs(bag, src.arguments, fieldSchema);
  }
  if (!target.arguments) {
    target.arguments = src.arguments;
  } else if (src.arguments) {
    let allArgsEqual = true;
    for (let srcArg of src.arguments) {
      // TODO what if 2 queries have 2 different values for the same arg?
      // for example, a change profile pic mutation that affects a getProfPic(size: "small") and getProfPic(size: "large")
      // we'd have to alias each by prefixing it with the componentId, eg COMMENT123__profPic
      // then, remove the prefix for the corresponding component id, and remove all others
      const matchingValue = target.arguments.find(targetSelection => targetSelection.name.value === srcArg.name.value);
      if (!matchingValue) {
        target.arguments.push(srcArg);
      }
    }
  }
};

const makeVariableDefinition = (argName, fieldSchema) => {
  const argSchema = fieldSchema.args.find(schemaArg => schemaArg.name === argName);
  if (!argSchema) {
    throw new Error(`invalid argument: ${argName}`);
  }
  const argType = ensureRootType(argSchema.type);
  return {
    defaultValue: null,
    kind: VARIABLE_DEFINITION,
    type: {
      kind: NAMED_TYPE,
      name: {
        kind: NAME,
        value: argType.name
      }
    },
    variable: {
      kind: VARIABLE,
      name: {
        kind: NAME,
        value: argName
      }
    }
  }
};