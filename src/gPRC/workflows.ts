import { proxyActivities } from '@temporalio/workflow';

type OpaInput = {
    user: string;
    action: string;
};

type OpaActivities = {
    evaluateAllow(input: OpaInput): Promise<boolean>;
};

const { evaluateAllow } = proxyActivities<OpaActivities>({
    startToCloseTimeout: '1 minute',
});

export async function helloWorkflow(name: string): Promise<string> {
    return `hello ${name}`;
}

export async function helloWorkflow2(input: OpaInput): Promise<string> {
    const allow = await evaluateAllow(input);
    return allow ? `allowed: ${input.user}/${input.action}` : `denied: ${input.user}/${input.action}`;
}
