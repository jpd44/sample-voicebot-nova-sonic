import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface SpeechLabStackProps extends cdk.StackProps {
    parentDomain: string;
    hostedZoneId: string;
    subdomain: string;
    desiredTaskCount: number;
    budgetEmail?: string;
    cognitoUserPoolId: string;
    cognitoClientId: string;
}
export declare class SpeechLabStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SpeechLabStackProps);
}
