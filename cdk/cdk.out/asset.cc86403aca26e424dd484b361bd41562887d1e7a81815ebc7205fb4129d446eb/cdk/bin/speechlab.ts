#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SpeechLabStack } from '../lib/speechlab-stack';

const app = new cdk.App();

new SpeechLabStack(app, 'SpeechLabStack', {
    // daily-deutsch account, anchored to us-east-1 so CloudFront can use the ACM cert here
    env: { account: '376210053828', region: 'us-east-1' },
    parentDomain: 'daily-deutsch.com',
    hostedZoneId: 'Z07189423NPO72TQYBDBS',
    subdomain: 'speechlab',
    desiredTaskCount: 1,
    budgetEmail: process.env.SPEECHLAB_ALERT_EMAIL,
    cognitoUserPoolId: 'us-east-1_dqBKmK639',
    cognitoClientId: '2uspue6gjg3dug6ugsprcj3u23',
});
