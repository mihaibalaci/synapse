#!/usr/bin/env node
/**
 * CDK App Entry Point
 *
 * Deploys the Recall infrastructure to AWS.
 * Stacks:
 *   - NetworkStack: VPC, subnets, security groups
 *   - DataStack: RDS (PostgreSQL + pgvector), ElastiCache (Redis), S3, OpenSearch
 *   - ComputeStack: ECS Fargate services (API + workers)
 *   - MonitoringStack: CloudWatch dashboards, alarms, OpenTelemetry
 */

import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const stage = app.node.tryGetContext('stage') ?? 'dev';

// ─── Network Stack ───────────────────────────────────────────────────────────

const networkStack = new NetworkStack(app, `Recall-Network-${stage}`, {
  env,
  stage,
});

// ─── Data Stack ──────────────────────────────────────────────────────────────

const dataStack = new DataStack(app, `Recall-Data-${stage}`, {
  env,
  stage,
  vpc: networkStack.vpc,
  securityGroups: networkStack.securityGroups,
});

// ─── Compute Stack ───────────────────────────────────────────────────────────

const computeStack = new ComputeStack(app, `Recall-Compute-${stage}`, {
  env,
  stage,
  vpc: networkStack.vpc,
  securityGroups: networkStack.securityGroups,
  database: dataStack.database,
  redis: dataStack.redis,
  bucket: dataStack.bucket,
  openSearch: dataStack.openSearchDomain,
});

// Add dependency ordering
dataStack.addDependency(networkStack);
computeStack.addDependency(dataStack);

app.synth();
