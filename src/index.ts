import {
	GraphQLError,
	Kind,
	DefinitionNode,
	FragmentDefinitionNode,
	OperationDefinitionNode,
	ValidationContext,
	ASTNode,
} from 'graphql';

function arrify(value: any) {
	if (value === null || value === undefined) {
		return [];
	}

	if (Array.isArray(value)) {
		return value;
	}

	if (typeof value === 'string') {
		return [value];
	}

	if (typeof value[Symbol.iterator] === 'function') {
		return [...value];
	}

	return [value];
}

/**
 * Creates a validator for the GraphQL query depth
 * @param {Number} maxDepth - The maximum allowed depth for any operation in a GraphQL document.
 * @param {Object} [options]
 * @param {String|RegExp|Function} options.ignore - Stops recursive depth checking based on a field name. Either a string or regexp to match the name, or a function that reaturns a boolean.
 * @param {Function} [callback] - Called each time validation runs. Receives an Object which is a map of the depths for each operation.
 * @returns {Function} The validator function for GraphQL validation phase.
 */
const depthLimit =
	(maxDepth: number, options?: { ignore: string | RegExp | Function }, callback?: (_: Map<string, number>) => void) =>
	(validationContext: ValidationContext) => {
		try {
			const { definitions } = validationContext.getDocument();
			const fragments = getFragments(definitions);
			const queries = getQueriesAndMutations(definitions);
			const queryDepths = new Map<string, number>();
			queries.forEach((node, name) => {
				const depth = determineDepth(node, fragments, 0, maxDepth, validationContext, name, options);
				queryDepths.set(name, depth);
			});

			callback && callback(queryDepths);
			return validationContext;
		} catch (err) {
			console.error(err);
			throw err;
		}
	};

module.exports = depthLimit;

function getFragments(definitions: readonly DefinitionNode[]): Map<string, FragmentDefinitionNode> {
	let map = new Map<string, FragmentDefinitionNode>();

	for (let definition of definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION) {
			map.set(definition.name.value, definition);
		}
	}
	return map;
}

// this will actually get both queries and mutations. we can basically treat those the same
function getQueriesAndMutations(definitions: readonly DefinitionNode[]) {
	let map = new Map<string, OperationDefinitionNode>();

	for (let definition of definitions) {
		if (definition.kind === Kind.OPERATION_DEFINITION) {
			map.set(definition.name ? definition.name.value : '', definition);
		}
	}

	return map;
}

function determineDepth(
	node: ASTNode,
	fragments: Map<string, FragmentDefinitionNode>,
	depthSoFar: number,
	maxDepth: number,
	context: ValidationContext,
	operationName: string,
	options?: { ignore: string | RegExp | Function }
): number {
	if (depthSoFar > maxDepth) {
		context.reportError(new GraphQLError(`'${operationName}' exceeds maximum operation depth of ${maxDepth}`, [node]));
		return -1;
	}

	switch (node.kind) {
		case Kind.FIELD:
			// by default, ignore the introspection fields which begin with double underscores
			const shouldIgnore = /^__/.test(node.name.value) || seeIfIgnored(node, options?.ignore);

			if (shouldIgnore || !node.selectionSet) {
				return 0;
			}
			return (
				1 +
				Math.max(
					...node.selectionSet.selections.map((selection) =>
						determineDepth(selection, fragments, depthSoFar + 1, maxDepth, context, operationName, options)
					)
				)
			);
		case Kind.FRAGMENT_SPREAD:
			const fragment = fragments.get(node.name.value);
			if (!fragment) {
				context.reportError(new GraphQLError(`'Fragment ${node.name.value} not found`, [node]));
				return -1;
			}
			return determineDepth(fragment, fragments, depthSoFar, maxDepth, context, operationName, options);

		case Kind.INLINE_FRAGMENT:
		case Kind.FRAGMENT_DEFINITION:
		case Kind.OPERATION_DEFINITION:
			return Math.max(
				...node.selectionSet.selections.map((selection) =>
					determineDepth(selection, fragments, depthSoFar, maxDepth, context, operationName, options)
				)
			);
		default:
			throw new Error('uh oh! depth crawler cannot handle: ' + node.kind);
	}
}

function seeIfIgnored(node: ASTNode, ignore?: string | RegExp | Function) {
  if (!ignore) return false;

	for (let rule of arrify(ignore)) {
		if (node.kind === Kind.FIELD) {
			const fieldName = node.name.value;
			switch (rule.constructor) {
				case Function:
					if (rule(fieldName)) {
						return true;
					}
					break;
				case String:
				case RegExp:
					if (fieldName.match(rule)) {
						return true;
					}
					break;
				default:
					throw new Error(`Invalid ignore option: ${rule}`);
			}
		}
	}
	return false;
}
