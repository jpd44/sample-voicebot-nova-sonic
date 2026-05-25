import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as budgets from 'aws-cdk-lib/aws-budgets';

export interface SpeechLabStackProps extends cdk.StackProps {
    parentDomain: string;        // e.g. 'daily-deutsch.com'
    hostedZoneId: string;        // Route 53 zone ID for parentDomain
    subdomain: string;           // e.g. 'speechlab' → speechlab.daily-deutsch.com
    desiredTaskCount: number;
    budgetEmail?: string;        // optional — wired only if provided
    cognitoUserPoolId: string;   // existing user pool to gate access
    cognitoClientId: string;     // app client (browser SRP, no client secret)
}

export class SpeechLabStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SpeechLabStackProps) {
        super(scope, id, props);

        const fqdn = `${props.subdomain}.${props.parentDomain}`;

        // ─── DNS / TLS ─────────────────────────────────────────────────────
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.parentDomain,
        });

        // ACM cert for the subdomain, DNS-validated. Must be in us-east-1 for CloudFront —
        // we anchor the whole stack to us-east-1 in bin/speechlab.ts so this works inline.
        const certificate = new acm.Certificate(this, 'Certificate', {
            domainName: fqdn,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        // ─── Networking ───────────────────────────────────────────────────
        // Public subnets only — Fargate tasks get a public IP and talk to Bedrock directly.
        // Skipping NAT keeps idle cost low (~$32/mo per NAT GW saved).
        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            ],
        });

        // ─── ECS cluster + Fargate task ──────────────────────────────────
        const cluster = new ecs.Cluster(this, 'Cluster', {
            vpc,
            containerInsights: true,
        });

        const logGroup = new logs.LogGroup(this, 'AppLogs', {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            cpu: 256,
            memoryLimitMiB: 512,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });

        // Bedrock permissions on the task role (not execution role)
        taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:InvokeModelWithBidirectionalStream',
                'bedrock:Converse',
                'bedrock:ConverseStream',
            ],
            resources: [
                // Nova Sonic — foundation model, all regions
                'arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0',
                // Cross-region inference profiles for Claude (us.* prefix)
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
                // The underlying foundation models the inference profile routes to
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
                'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
                'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
                'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
                'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
            ],
        }));

        // Container — built from the Dockerfile at the repo root (one level up)
        const container = taskDef.addContainer('app', {
            image: ecs.ContainerImage.fromAsset('..', {
                // Tell CDK to build for the task's ARM64 architecture
                platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
            }),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'speechlab',
                logGroup,
            }),
            environment: {
                AWS_REGION: this.region,
                HOST: '0.0.0.0',
                PORT: '3000',
                NODE_ENV: 'production',
                COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
                COGNITO_CLIENT_ID: props.cognitoClientId,
                COGNITO_REGION: this.region,
            },
            essential: true,
        });
        container.addPortMappings({ containerPort: 3000, protocol: ecs.Protocol.TCP });

        // ALB-fronted Fargate service.
        // CloudFront terminates TLS for users; the CloudFront→ALB hop uses plain HTTP. This avoids
        // the SNI/cert-name mismatch you'd get if CloudFront tried HTTPS to the raw ALB hostname
        // (the cert is bound to the FQDN, not the ALB DNS). Future hardening: restrict ALB SG
        // ingress to the com.amazonaws.global.cloudfront.origin-facing managed prefix list.
        const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
            cluster,
            taskDefinition: taskDef,
            desiredCount: props.desiredTaskCount,
            assignPublicIp: true,
            publicLoadBalancer: true,
            protocol: elbv2.ApplicationProtocol.HTTP,
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            circuitBreaker: { rollback: true },
            // At desiredCount=1 we accept brief downtime during deploys; the new task replaces the old one.
            minHealthyPercent: 0,
            maxHealthyPercent: 200,
        });

        // Tune health check + draining for the Socket.IO long-lived connections
        service.targetGroup.configureHealthCheck({
            path: '/health',
            interval: cdk.Duration.seconds(30),
            timeout: cdk.Duration.seconds(5),
            healthyHttpCodes: '200',
        });
        service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
        service.targetGroup.setAttribute('stickiness.enabled', 'true');
        service.targetGroup.setAttribute('stickiness.type', 'lb_cookie');
        service.targetGroup.setAttribute('stickiness.lb_cookie.duration_seconds', '3600');

        // ─── CloudFront in front of the ALB ──────────────────────────────
        // No S3 origin — the Node server serves static assets out of public/ already.
        // We could split static off to S3 later; keeping it simple to start.
        const albOrigin = new cloudfrontOrigins.LoadBalancerV2Origin(service.loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
                // Identifies traffic that's gone through CloudFront vs hit the ALB directly.
                // We don't enforce on it yet, but a future hardening step can require this header
                // (in addition to security-group prefix-list restriction).
                'x-from-cloudfront': cdk.Names.uniqueId(this).slice(-12),
            },
        });

        const wsBehavior: cloudfront.BehaviorOptions = {
            origin: albOrigin,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
            compress: false,
        };

        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: albOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
            },
            additionalBehaviors: {
                'socket.io/*': wsBehavior,
                'api/*': wsBehavior,
                'health': wsBehavior,
            },
            domainNames: [fqdn],
            certificate,
            httpVersion: cloudfront.HttpVersion.HTTP2,   // HTTP/2 to viewers; ALB hop is HTTP/1.1 for WS upgrade
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,   // US + Europe edges — fine for daily-deutsch.com EU audience
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        });

        // Replace the ALB-pointing A-record we tried to remove above with one pointing at CloudFront
        new route53.ARecord(this, 'AliasRecord', {
            zone,
            recordName: props.subdomain,
            target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
            comment: 'speechlab → CloudFront → ALB → Fargate',
        });

        // ─── Budget alert (optional) ──────────────────────────────────────
        if (props.budgetEmail) {
            new budgets.CfnBudget(this, 'CostAlert', {
                budget: {
                    budgetName: `${id}-daily-cost-cap`,
                    budgetType: 'COST',
                    timeUnit: 'DAILY',
                    budgetLimit: { amount: 50, unit: 'USD' },
                },
                notificationsWithSubscribers: [{
                    notification: {
                        notificationType: 'ACTUAL',
                        comparisonOperator: 'GREATER_THAN',
                        threshold: 100,
                        thresholdType: 'PERCENTAGE',
                    },
                    subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
                }],
            });
        }

        // ─── Outputs ──────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'AppUrl', { value: `https://${fqdn}` });
        new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName });
        new cdk.CfnOutput(this, 'AlbDnsName', { value: service.loadBalancer.loadBalancerDnsName });
        new cdk.CfnOutput(this, 'EcrRepoNote', { value: 'Image is built by CDK and pushed to the CDK assets ECR repo.' });
    }
}
