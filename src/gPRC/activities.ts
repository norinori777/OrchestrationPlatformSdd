import { evaluateAllow, type OpaInput } from '../Opa/opa.ts';

export async function evaluateAllowActivity(input: OpaInput): Promise<boolean> {
	return evaluateAllow(input);
}