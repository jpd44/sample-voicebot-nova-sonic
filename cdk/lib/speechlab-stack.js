"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeechLabStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecsPatterns = __importStar(require("aws-cdk-lib/aws-ecs-patterns"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const route53Targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const cloudfrontOrigins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const budgets = __importStar(require("aws-cdk-lib/aws-budgets"));
class SpeechLabStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        // ALB-fronted Fargate service. ALB serves HTTPS using the same ACM cert that's bound
        // to speechlab.daily-deutsch.com. End-to-end TLS works because CloudFront forwards the
        // viewer Host header (speechlab.daily-deutsch.com) as the SNI when talking to the ALB,
        // and that Host matches the ALB cert. The origin-request policies below preserve the Host.
        const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
            cluster,
            taskDefinition: taskDef,
            desiredCount: props.desiredTaskCount,
            assignPublicIp: true,
            publicLoadBalancer: true,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificate,
            redirectHTTP: true,
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
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: {
                // Identifies traffic that's gone through CloudFront vs hit the ALB directly.
                // We don't enforce on it yet, but a future hardening step can require this header
                // (in addition to security-group prefix-list restriction).
                'x-from-cloudfront': cdk.Names.uniqueId(this).slice(-12),
            },
        });
        const wsBehavior = {
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
                // Forward the viewer Host so CloudFront's SNI to the origin matches the ALB cert.
                // CACHING_OPTIMIZED still caches by URI only, so static assets stay cacheable.
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                compress: true,
            },
            additionalBehaviors: {
                'socket.io/*': wsBehavior,
                'api/*': wsBehavior,
                'health': wsBehavior,
            },
            domainNames: [fqdn],
            certificate,
            httpVersion: cloudfront.HttpVersion.HTTP2, // HTTP/2 to viewers; ALB hop is HTTP/1.1 for WS upgrade
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + Europe edges — fine for daily-deutsch.com EU audience
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
exports.SpeechLabStack = SpeechLabStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3BlZWNobGFiLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3BlZWNobGFiLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUVuQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLDBFQUE0RDtBQUM1RCw4RUFBZ0U7QUFDaEUseURBQTJDO0FBQzNDLDJEQUE2QztBQUM3Qyx3RUFBMEQ7QUFDMUQsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUNsRSx1RUFBeUQ7QUFDekQsc0ZBQXdFO0FBQ3hFLGlFQUFtRDtBQVluRCxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUN6QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTBCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sSUFBSSxHQUFHLEdBQUcsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFeEQsc0VBQXNFO1FBQ3RFLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRTtZQUNuRSxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVk7WUFDaEMsUUFBUSxFQUFFLEtBQUssQ0FBQyxZQUFZO1NBQy9CLENBQUMsQ0FBQztRQUVILG1GQUFtRjtRQUNuRixtRkFBbUY7UUFDbkYsTUFBTSxXQUFXLEdBQUcsSUFBSSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDekQsVUFBVSxFQUFFLElBQUk7WUFDaEIsVUFBVSxFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1NBQ3RELENBQUMsQ0FBQztRQUVILHFFQUFxRTtRQUNyRSxvRkFBb0Y7UUFDcEYsK0RBQStE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O2dCQUNELDRCQUE0QixFQUFFLENBQUM7d0JBQzNCLFlBQVksRUFBRTs0QkFDVixnQkFBZ0IsRUFBRSxRQUFROzRCQUMxQixrQkFBa0IsRUFBRSxjQUFjOzRCQUNsQyxTQUFTLEVBQUUsR0FBRzs0QkFDZCxhQUFhLEVBQUUsWUFBWTt5QkFDOUI7d0JBQ0QsV0FBVyxFQUFFLENBQUMsRUFBRSxnQkFBZ0IsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztxQkFDM0UsQ0FBQzthQUNMLENBQUMsQ0FBQztRQUNQLENBQUM7UUFFRCxxRUFBcUU7UUFDckUsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsV0FBVyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDaEUsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRSxFQUFFLEtBQUssRUFBRSxZQUFZLENBQUMsc0JBQXNCLEVBQUUsQ0FBQyxDQUFDO1FBQzVGLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxDQUFDO1FBQzNGLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFLEVBQUUsS0FBSyxFQUFFLDhEQUE4RCxFQUFFLENBQUMsQ0FBQztJQUN0SCxDQUFDO0NBQ0o7QUFsTkQsd0NBa05DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNzUGF0dGVybnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcy1wYXR0ZXJucyc7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGFjbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMnO1xuaW1wb3J0ICogYXMgcm91dGU1M1RhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0cyc7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250JztcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnRPcmlnaW5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnMnO1xuaW1wb3J0ICogYXMgYnVkZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYnVkZ2V0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3BlZWNoTGFiU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgICBwYXJlbnREb21haW46IHN0cmluZzsgICAgICAgIC8vIGUuZy4gJ2RhaWx5LWRldXRzY2guY29tJ1xuICAgIGhvc3RlZFpvbmVJZDogc3RyaW5nOyAgICAgICAgLy8gUm91dGUgNTMgem9uZSBJRCBmb3IgcGFyZW50RG9tYWluXG4gICAgc3ViZG9tYWluOiBzdHJpbmc7ICAgICAgICAgICAvLyBlLmcuICdzcGVlY2hsYWInIOKGkiBzcGVlY2hsYWIuZGFpbHktZGV1dHNjaC5jb21cbiAgICBkZXNpcmVkVGFza0NvdW50OiBudW1iZXI7XG4gICAgYnVkZ2V0RW1haWw/OiBzdHJpbmc7ICAgICAgICAvLyBvcHRpb25hbCDigJQgd2lyZWQgb25seSBpZiBwcm92aWRlZFxuICAgIGNvZ25pdG9Vc2VyUG9vbElkOiBzdHJpbmc7ICAgLy8gZXhpc3RpbmcgdXNlciBwb29sIHRvIGdhdGUgYWNjZXNzXG4gICAgY29nbml0b0NsaWVudElkOiBzdHJpbmc7ICAgICAvLyBhcHAgY2xpZW50IChicm93c2VyIFNSUCwgbm8gY2xpZW50IHNlY3JldClcbn1cblxuZXhwb3J0IGNsYXNzIFNwZWVjaExhYlN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU3BlZWNoTGFiU3RhY2tQcm9wcykge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgICAgICBjb25zdCBmcWRuID0gYCR7cHJvcHMuc3ViZG9tYWlufS4ke3Byb3BzLnBhcmVudERvbWFpbn1gO1xuXG4gICAgICAgIC8vIOKUgOKUgOKUgCBETlMgLyBUTFMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgICAgIGNvbnN0IHpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUhvc3RlZFpvbmVBdHRyaWJ1dGVzKHRoaXMsICdab25lJywge1xuICAgICAgICAgICAgaG9zdGVkWm9uZUlkOiBwcm9wcy5ob3N0ZWRab25lSWQsXG4gICAgICAgICAgICB6b25lTmFtZTogcHJvcHMucGFyZW50RG9tYWluLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBQ00gY2VydCBmb3IgdGhlIHN1YmRvbWFpbiwgRE5TLXZhbGlkYXRlZC4gTXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIENsb3VkRnJvbnQg4oCUXG4gICAgICAgIC8vIHdlIGFuY2hvciB0aGUgd2hvbGUgc3RhY2sgdG8gdXMtZWFzdC0xIGluIGJpbi9zcGVlY2hsYWIudHMgc28gdGhpcyB3b3JrcyBpbmxpbmUuXG4gICAgICAgIGNvbnN0IGNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCAnQ2VydGlmaWNhdGUnLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBmcWRuLFxuICAgICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHpvbmUpLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyDilIDilIDilIAgTmV0d29ya2luZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAgICAgLy8gUHVibGljIHN1Ym5ldHMgb25seSDigJQgRmFyZ2F0ZSB0YXNrcyBnZXQgYSBwdWJsaWMgSVAgYW5kIHRhbGsgdG8gQmVkcm9jayBkaXJlY3RseS5cbiAgICAgICAgLy8gU2tpcHBpbmcgTkFUIGtlZXBzIGlkbGUgY29zdCBsb3cgKH4kMzIvbW8gcGVyIE5BVCBHVyBzYXZlZCkuXG4gICAgICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdWcGMnLCB7XG4gICAgICAgICAgICBtYXhBenM6IDIsXG4gICAgICAgICAgICBuYXRHYXRld2F5czogMCxcbiAgICAgICAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAgICAgICAgICB7IG5hbWU6ICdwdWJsaWMnLCBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8g4pSA4pSA4pSAIEVDUyBjbHVzdGVyICsgRmFyZ2F0ZSB0YXNrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdDbHVzdGVyJywge1xuICAgICAgICAgICAgdnBjLFxuICAgICAgICAgICAgY29udGFpbmVySW5zaWdodHM6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0FwcExvZ3MnLCB7XG4gICAgICAgICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB0YXNrRGVmID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1Rhc2tEZWYnLCB7XG4gICAgICAgICAgICBjcHU6IDI1NixcbiAgICAgICAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICAgICAgICBydW50aW1lUGxhdGZvcm06IHtcbiAgICAgICAgICAgICAgICBjcHVBcmNoaXRlY3R1cmU6IGVjcy5DcHVBcmNoaXRlY3R1cmUuQVJNNjQsXG4gICAgICAgICAgICAgICAgb3BlcmF0aW5nU3lzdGVtRmFtaWx5OiBlY3MuT3BlcmF0aW5nU3lzdGVtRmFtaWx5LkxJTlVYLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQmVkcm9jayBwZXJtaXNzaW9ucyBvbiB0aGUgdGFzayByb2xlIChub3QgZXhlY3V0aW9uIHJvbGUpXG4gICAgICAgIHRhc2tEZWYudGFza1JvbGUuYWRkVG9QcmluY2lwYWxQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsJyxcbiAgICAgICAgICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWxXaXRoQmlkaXJlY3Rpb25hbFN0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2JlZHJvY2s6Q29udmVyc2UnLFxuICAgICAgICAgICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgICAvLyBOb3ZhIFNvbmljIOKAlCBmb3VuZGF0aW9uIG1vZGVsLCBhbGwgcmVnaW9uc1xuICAgICAgICAgICAgICAgICdhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC9hbWF6b24ubm92YS0yLXNvbmljLXYxOjAnLFxuICAgICAgICAgICAgICAgIC8vIENyb3NzLXJlZ2lvbiBpbmZlcmVuY2UgcHJvZmlsZXMgZm9yIENsYXVkZSAodXMuKiBwcmVmaXgpXG4gICAgICAgICAgICAgICAgYGFybjphd3M6YmVkcm9jazoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06aW5mZXJlbmNlLXByb2ZpbGUvdXMuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBgLFxuICAgICAgICAgICAgICAgIGBhcm46YXdzOmJlZHJvY2s6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmluZmVyZW5jZS1wcm9maWxlL3VzLmFudGhyb3BpYy5jbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxLXYxOjBgLFxuICAgICAgICAgICAgICAgIC8vIFRoZSB1bmRlcmx5aW5nIGZvdW5kYXRpb24gbW9kZWxzIHRoZSBpbmZlcmVuY2UgcHJvZmlsZSByb3V0ZXMgdG9cbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLWVhc3QtMTo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTUtMjAyNTA5MjktdjE6MCcsXG4gICAgICAgICAgICAgICAgJ2Fybjphd3M6YmVkcm9jazp1cy1lYXN0LTI6OmZvdW5kYXRpb24tbW9kZWwvYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjAnLFxuICAgICAgICAgICAgICAgICdhcm46YXdzOmJlZHJvY2s6dXMtd2VzdC0yOjpmb3VuZGF0aW9uLW1vZGVsL2FudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNS0yMDI1MDkyOS12MTowJyxcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLWVhc3QtMTo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMS12MTowJyxcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLWVhc3QtMjo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMS12MTowJyxcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLXdlc3QtMjo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMS12MTowJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0pKTtcblxuICAgICAgICAvLyBDb250YWluZXIg4oCUIGJ1aWx0IGZyb20gdGhlIERvY2tlcmZpbGUgYXQgdGhlIHJlcG8gcm9vdCAob25lIGxldmVsIHVwKVxuICAgICAgICBjb25zdCBjb250YWluZXIgPSB0YXNrRGVmLmFkZENvbnRhaW5lcignYXBwJywge1xuICAgICAgICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tQXNzZXQoJy4uJywge1xuICAgICAgICAgICAgICAgIC8vIFRlbGwgQ0RLIHRvIGJ1aWxkIGZvciB0aGUgdGFzaydzIEFSTTY0IGFyY2hpdGVjdHVyZVxuICAgICAgICAgICAgICAgIHBsYXRmb3JtOiBjZGsuYXdzX2Vjcl9hc3NldHMuUGxhdGZvcm0uTElOVVhfQVJNNjQsXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgICAgICAgIHN0cmVhbVByZWZpeDogJ3NwZWVjaGxhYicsXG4gICAgICAgICAgICAgICAgbG9nR3JvdXAsXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgICAgICAgQVdTX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgICAgICAgICAgSE9TVDogJzAuMC4wLjAnLFxuICAgICAgICAgICAgICAgIFBPUlQ6ICczMDAwJyxcbiAgICAgICAgICAgICAgICBOT0RFX0VOVjogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICAgICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiBwcm9wcy5jb2duaXRvVXNlclBvb2xJZCxcbiAgICAgICAgICAgICAgICBDT0dOSVRPX0NMSUVOVF9JRDogcHJvcHMuY29nbml0b0NsaWVudElkLFxuICAgICAgICAgICAgICAgIENPR05JVE9fUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBlc3NlbnRpYWw6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBjb250YWluZXIuYWRkUG9ydE1hcHBpbmdzKHsgY29udGFpbmVyUG9ydDogMzAwMCwgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AgfSk7XG5cbiAgICAgICAgLy8gQUxCLWZyb250ZWQgRmFyZ2F0ZSBzZXJ2aWNlLiBBTEIgc2VydmVzIEhUVFBTIHVzaW5nIHRoZSBzYW1lIEFDTSBjZXJ0IHRoYXQncyBib3VuZFxuICAgICAgICAvLyB0byBzcGVlY2hsYWIuZGFpbHktZGV1dHNjaC5jb20uIEVuZC10by1lbmQgVExTIHdvcmtzIGJlY2F1c2UgQ2xvdWRGcm9udCBmb3J3YXJkcyB0aGVcbiAgICAgICAgLy8gdmlld2VyIEhvc3QgaGVhZGVyIChzcGVlY2hsYWIuZGFpbHktZGV1dHNjaC5jb20pIGFzIHRoZSBTTkkgd2hlbiB0YWxraW5nIHRvIHRoZSBBTEIsXG4gICAgICAgIC8vIGFuZCB0aGF0IEhvc3QgbWF0Y2hlcyB0aGUgQUxCIGNlcnQuIFRoZSBvcmlnaW4tcmVxdWVzdCBwb2xpY2llcyBiZWxvdyBwcmVzZXJ2ZSB0aGUgSG9zdC5cbiAgICAgICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3NQYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlKHRoaXMsICdTZXJ2aWNlJywge1xuICAgICAgICAgICAgY2x1c3RlcixcbiAgICAgICAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmLFxuICAgICAgICAgICAgZGVzaXJlZENvdW50OiBwcm9wcy5kZXNpcmVkVGFza0NvdW50LFxuICAgICAgICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsXG4gICAgICAgICAgICBwdWJsaWNMb2FkQmFsYW5jZXI6IHRydWUsXG4gICAgICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgICAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgICAgICAgcmVkaXJlY3RIVFRQOiB0cnVlLFxuICAgICAgICAgICAgaGVhbHRoQ2hlY2tHcmFjZVBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgcm9sbGJhY2s6IHRydWUgfSxcbiAgICAgICAgICAgIC8vIEF0IGRlc2lyZWRDb3VudD0xIHdlIGFjY2VwdCBicmllZiBkb3dudGltZSBkdXJpbmcgZGVwbG95czsgdGhlIG5ldyB0YXNrIHJlcGxhY2VzIHRoZSBvbGQgb25lLlxuICAgICAgICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDAsXG4gICAgICAgICAgICBtYXhIZWFsdGh5UGVyY2VudDogMjAwLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUdW5lIGhlYWx0aCBjaGVjayArIGRyYWluaW5nIGZvciB0aGUgU29ja2V0LklPIGxvbmctbGl2ZWQgY29ubmVjdGlvbnNcbiAgICAgICAgc2VydmljZS50YXJnZXRHcm91cC5jb25maWd1cmVIZWFsdGhDaGVjayh7XG4gICAgICAgICAgICBwYXRoOiAnL2hlYWx0aCcsXG4gICAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHNlcnZpY2UudGFyZ2V0R3JvdXAuc2V0QXR0cmlidXRlKCdkZXJlZ2lzdHJhdGlvbl9kZWxheS50aW1lb3V0X3NlY29uZHMnLCAnMzAnKTtcbiAgICAgICAgc2VydmljZS50YXJnZXRHcm91cC5zZXRBdHRyaWJ1dGUoJ3N0aWNraW5lc3MuZW5hYmxlZCcsICd0cnVlJyk7XG4gICAgICAgIHNlcnZpY2UudGFyZ2V0R3JvdXAuc2V0QXR0cmlidXRlKCdzdGlja2luZXNzLnR5cGUnLCAnbGJfY29va2llJyk7XG4gICAgICAgIHNlcnZpY2UudGFyZ2V0R3JvdXAuc2V0QXR0cmlidXRlKCdzdGlja2luZXNzLmxiX2Nvb2tpZS5kdXJhdGlvbl9zZWNvbmRzJywgJzM2MDAnKTtcblxuICAgICAgICAvLyDilIDilIDilIAgQ2xvdWRGcm9udCBpbiBmcm9udCBvZiB0aGUgQUxCIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgICAvLyBObyBTMyBvcmlnaW4g4oCUIHRoZSBOb2RlIHNlcnZlciBzZXJ2ZXMgc3RhdGljIGFzc2V0cyBvdXQgb2YgcHVibGljLyBhbHJlYWR5LlxuICAgICAgICAvLyBXZSBjb3VsZCBzcGxpdCBzdGF0aWMgb2ZmIHRvIFMzIGxhdGVyOyBrZWVwaW5nIGl0IHNpbXBsZSB0byBzdGFydC5cbiAgICAgICAgY29uc3QgYWxiT3JpZ2luID0gbmV3IGNsb3VkZnJvbnRPcmlnaW5zLkxvYWRCYWxhbmNlclYyT3JpZ2luKHNlcnZpY2UubG9hZEJhbGFuY2VyLCB7XG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgY3VzdG9tSGVhZGVyczoge1xuICAgICAgICAgICAgICAgIC8vIElkZW50aWZpZXMgdHJhZmZpYyB0aGF0J3MgZ29uZSB0aHJvdWdoIENsb3VkRnJvbnQgdnMgaGl0IHRoZSBBTEIgZGlyZWN0bHkuXG4gICAgICAgICAgICAgICAgLy8gV2UgZG9uJ3QgZW5mb3JjZSBvbiBpdCB5ZXQsIGJ1dCBhIGZ1dHVyZSBoYXJkZW5pbmcgc3RlcCBjYW4gcmVxdWlyZSB0aGlzIGhlYWRlclxuICAgICAgICAgICAgICAgIC8vIChpbiBhZGRpdGlvbiB0byBzZWN1cml0eS1ncm91cCBwcmVmaXgtbGlzdCByZXN0cmljdGlvbikuXG4gICAgICAgICAgICAgICAgJ3gtZnJvbS1jbG91ZGZyb250JzogY2RrLk5hbWVzLnVuaXF1ZUlkKHRoaXMpLnNsaWNlKC0xMiksXG4gICAgICAgICAgICB9LFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB3c0JlaGF2aW9yOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9IHtcbiAgICAgICAgICAgIG9yaWdpbjogYWxiT3JpZ2luLFxuICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5LkFMTF9WSUVXRVIsXG4gICAgICAgICAgICBjb21wcmVzczogZmFsc2UsXG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsICdEaXN0cmlidXRpb24nLCB7XG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFsYk9yaWdpbixcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRCxcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgICAgICAvLyBGb3J3YXJkIHRoZSB2aWV3ZXIgSG9zdCBzbyBDbG91ZEZyb250J3MgU05JIHRvIHRoZSBvcmlnaW4gbWF0Y2hlcyB0aGUgQUxCIGNlcnQuXG4gICAgICAgICAgICAgICAgLy8gQ0FDSElOR19PUFRJTUlaRUQgc3RpbGwgY2FjaGVzIGJ5IFVSSSBvbmx5LCBzbyBzdGF0aWMgYXNzZXRzIHN0YXkgY2FjaGVhYmxlLlxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5BTExfVklFV0VSLFxuICAgICAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnM6IHtcbiAgICAgICAgICAgICAgICAnc29ja2V0LmlvLyonOiB3c0JlaGF2aW9yLFxuICAgICAgICAgICAgICAgICdhcGkvKic6IHdzQmVoYXZpb3IsXG4gICAgICAgICAgICAgICAgJ2hlYWx0aCc6IHdzQmVoYXZpb3IsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZG9tYWluTmFtZXM6IFtmcWRuXSxcbiAgICAgICAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgICAgICAgaHR0cFZlcnNpb246IGNsb3VkZnJvbnQuSHR0cFZlcnNpb24uSFRUUDIsICAgLy8gSFRUUC8yIHRvIHZpZXdlcnM7IEFMQiBob3AgaXMgSFRUUC8xLjEgZm9yIFdTIHVwZ3JhZGVcbiAgICAgICAgICAgIHByaWNlQ2xhc3M6IGNsb3VkZnJvbnQuUHJpY2VDbGFzcy5QUklDRV9DTEFTU18xMDAsICAgLy8gVVMgKyBFdXJvcGUgZWRnZXMg4oCUIGZpbmUgZm9yIGRhaWx5LWRldXRzY2guY29tIEVVIGF1ZGllbmNlXG4gICAgICAgICAgICBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uOiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2wuVExTX1YxXzJfMjAyMSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUmVwbGFjZSB0aGUgQUxCLXBvaW50aW5nIEEtcmVjb3JkIHdlIHRyaWVkIHRvIHJlbW92ZSBhYm92ZSB3aXRoIG9uZSBwb2ludGluZyBhdCBDbG91ZEZyb250XG4gICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgJ0FsaWFzUmVjb3JkJywge1xuICAgICAgICAgICAgem9uZSxcbiAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLnN1YmRvbWFpbixcbiAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzVGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KGRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgY29tbWVudDogJ3NwZWVjaGxhYiDihpIgQ2xvdWRGcm9udCDihpIgQUxCIOKGkiBGYXJnYXRlJyxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8g4pSA4pSA4pSAIEJ1ZGdldCBhbGVydCAob3B0aW9uYWwpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgICBpZiAocHJvcHMuYnVkZ2V0RW1haWwpIHtcbiAgICAgICAgICAgIG5ldyBidWRnZXRzLkNmbkJ1ZGdldCh0aGlzLCAnQ29zdEFsZXJ0Jywge1xuICAgICAgICAgICAgICAgIGJ1ZGdldDoge1xuICAgICAgICAgICAgICAgICAgICBidWRnZXROYW1lOiBgJHtpZH0tZGFpbHktY29zdC1jYXBgLFxuICAgICAgICAgICAgICAgICAgICBidWRnZXRUeXBlOiAnQ09TVCcsXG4gICAgICAgICAgICAgICAgICAgIHRpbWVVbml0OiAnREFJTFknLFxuICAgICAgICAgICAgICAgICAgICBidWRnZXRMaW1pdDogeyBhbW91bnQ6IDUwLCB1bml0OiAnVVNEJyB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgbm90aWZpY2F0aW9uc1dpdGhTdWJzY3JpYmVyczogW3tcbiAgICAgICAgICAgICAgICAgICAgbm90aWZpY2F0aW9uOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBub3RpZmljYXRpb25UeXBlOiAnQUNUVUFMJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogJ0dSRUFURVJfVEhBTicsXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJlc2hvbGQ6IDEwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocmVzaG9sZFR5cGU6ICdQRVJDRU5UQUdFJyxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaWJlcnM6IFt7IHN1YnNjcmlwdGlvblR5cGU6ICdFTUFJTCcsIGFkZHJlc3M6IHByb3BzLmJ1ZGdldEVtYWlsIH1dLFxuICAgICAgICAgICAgICAgIH1dLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDilIDilIDilIAgT3V0cHV0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcFVybCcsIHsgdmFsdWU6IGBodHRwczovLyR7ZnFkbn1gIH0pO1xuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRGcm9udERvbWFpbicsIHsgdmFsdWU6IGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lIH0pO1xuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxiRG5zTmFtZScsIHsgdmFsdWU6IHNlcnZpY2UubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWUgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3JSZXBvTm90ZScsIHsgdmFsdWU6ICdJbWFnZSBpcyBidWlsdCBieSBDREsgYW5kIHB1c2hlZCB0byB0aGUgQ0RLIGFzc2V0cyBFQ1IgcmVwby4nIH0pO1xuICAgIH1cbn1cbiJdfQ==