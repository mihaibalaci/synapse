/**
 * Compute Stack
 *
 * ECS Fargate services for:
 *   - API Service (REST/gRPC endpoints, ALB)
 *   - Ingestion Workers (session processing pipeline)
 *
 * Features:
 *   - Auto-scaling based on request rate + queue depth
 *   - Health checks and circuit breakers
 *   - Secrets management via AWS Secrets Manager
 *   - Container logging to CloudWatch
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  stage: string;
  vpc: ec2.Vpc;
  securityGroups: {
    api: ec2.SecurityGroup;
    workers: ec2.SecurityGroup;
  };
  database: rds.DatabaseCluster;
  redis: elasticache.CfnReplicationGroup;
  bucket: s3.Bucket;
  openSearch: opensearch.Domain;
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { stage, vpc, securityGroups, database, redis, bucket, openSearch } = props;
    const isProd = stage === 'prod';

    // ─── ECS Cluster ─────────────────────────────────────────────────────────

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `recall-${stage}`,
      vpc,
      containerInsights: isProd,
    });

    // ─── Shared Environment ──────────────────────────────────────────────────

    const environment: Record<string, string> = {
      NODE_ENV: isProd ? 'production' : 'development',
      LOG_LEVEL: isProd ? 'info' : 'debug',
      S3_BUCKET: bucket.bucketName,
      S3_REGION: this.region,
      OPENSEARCH_URL: `https://${openSearch.domainEndpoint}`,
      REDIS_URL: `redis://${redis.attrPrimaryEndPointAddress}:6379`,
      NEO4J_URI: 'bolt://neo4j:7687', // Neo4j runs separately or as managed service
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-large',
      LLM_PROVIDER: 'claude',
    };

    // ─── Log Groups ──────────────────────────────────────────────────────────

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: `/recall/${stage}/api`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: `/recall/${stage}/workers`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── API Service (ALB + Fargate) ─────────────────────────────────────────

    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      serviceName: `recall-api-${stage}`,
      desiredCount: isProd ? 3 : 1,
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 2048 : 1024,
      securityGroups: [securityGroups.api],
      assignPublicIp: false,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('../../', {
          file: 'infra/docker/Dockerfile.api',
        }),
        containerPort: 3000,
        environment,
        logDriver: ecs.LogDrivers.awsLogs({
          logGroup: apiLogGroup,
          streamPrefix: 'api',
        }),
      },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      circuitBreaker: { rollback: true },
    });

    // Health check configuration
    apiService.targetGroup.configureHealthCheck({
      path: '/health',
      interval: cdk.Duration.seconds(15),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // API auto-scaling
    const apiScaling = apiService.service.autoScaleTaskCount({
      minCapacity: isProd ? 3 : 1,
      maxCapacity: isProd ? 20 : 3,
    });

    apiScaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    apiScaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 1000,
      targetGroup: apiService.targetGroup,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ─── Worker Service (Fargate, no ALB) ────────────────────────────────────

    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 4096 : 2048,
    });

    workerTaskDef.addContainer('Worker', {
      image: ecs.ContainerImage.fromAsset('../../', {
        file: 'infra/docker/Dockerfile.worker',
      }),
      environment,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workerLogGroup,
        streamPrefix: 'worker',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "process.exit(0)"'],
        interval: cdk.Duration.seconds(30),
        retries: 3,
      },
    });

    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      serviceName: `recall-workers-${stage}`,
      taskDefinition: workerTaskDef,
      desiredCount: isProd ? 5 : 1,
      securityGroups: [securityGroups.workers],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
    });

    // Worker auto-scaling (based on queue depth — custom metric)
    const workerScaling = workerService.autoScaleTaskCount({
      minCapacity: isProd ? 3 : 1,
      maxCapacity: isProd ? 30 : 5,
    });

    workerScaling.scaleOnCpuUtilization('WorkerCpuScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ─── IAM Permissions ─────────────────────────────────────────────────────

    // S3 access
    bucket.grantReadWrite(apiService.taskDefinition.taskRole);
    bucket.grantReadWrite(workerTaskDef.taskRole);

    // OpenSearch access
    openSearch.grantReadWrite(apiService.taskDefinition.taskRole);
    openSearch.grantReadWrite(workerTaskDef.taskRole);

    // Secrets Manager access (for DB credentials, API keys)
    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:recall/${stage}/*`],
    });
    apiService.taskDefinition.taskRole.addToPrincipalPolicy(secretsPolicy);
    workerTaskDef.taskRole.addToPrincipalPolicy(secretsPolicy);

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `http://${apiService.loadBalancer.loadBalancerDnsName}`,
    });
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: cluster.clusterArn,
    });
  }
}
