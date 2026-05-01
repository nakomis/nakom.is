export type DeployEnv = 'sandbox' | 'prod';

export function envSuffix(deployEnv: DeployEnv): string {
    return deployEnv === 'prod' ? '' : '-sandbox';
}

export function ssmPrefix(deployEnv: DeployEnv): string {
    return deployEnv === 'prod' ? '/nakom.is/' : '/nakom.is/sandbox/';
}

export function logPrefix(deployEnv: DeployEnv): string {
    return deployEnv === 'prod' ? '/nakom.is' : '/nakom.is/sandbox';
}

export function domain(deployEnv: DeployEnv): string {
    return deployEnv === 'prod' ? 'nakom.is' : 'sandbox.nakom.is';
}
