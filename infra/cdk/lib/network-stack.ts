/**
 * Network Stack
 *
 * VPC with public/private subnets, NAT gateways, and security groups.
 * All data services run in private subnets; only the ALB is public.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface NetworkStackProps extends cdk.StackProps {
  stage: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroups: {
    api: ec2.SecurityGroup;
    workers: ec2.SecurityGroup;
    database: ec2.SecurityGroup;
    redis: ec2.SecurityGroup;
    opensearch: ec2.SecurityGroup;
  };

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // ─── VPC ─────────────────────────────────────────────────────────────────

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `recall-${stage}`,
      maxAzs: 3,
      natGateways: stage === 'prod' ? 3 : 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ─── Security Groups ─────────────────────────────────────────────────────

    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc: this.vpc,
      description: 'API service security group',
      securityGroupName: `recall-api-${stage}`,
    });

    const workersSg = new ec2.SecurityGroup(this, 'WorkersSg', {
      vpc: this.vpc,
      description: 'Worker services security group',
      securityGroupName: `recall-workers-${stage}`,
    });

    const databaseSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'PostgreSQL security group',
      securityGroupName: `recall-db-${stage}`,
    });

    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      description: 'Redis security group',
      securityGroupName: `recall-redis-${stage}`,
    });

    const opensearchSg = new ec2.SecurityGroup(this, 'OpenSearchSg', {
      vpc: this.vpc,
      description: 'OpenSearch security group',
      securityGroupName: `recall-opensearch-${stage}`,
    });

    // ─── Ingress Rules ───────────────────────────────────────────────────────

    // API and workers can access database
    databaseSg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'API access to PostgreSQL');
    databaseSg.addIngressRule(workersSg, ec2.Port.tcp(5432), 'Workers access to PostgreSQL');

    // API and workers can access Redis
    redisSg.addIngressRule(apiSg, ec2.Port.tcp(6379), 'API access to Redis');
    redisSg.addIngressRule(workersSg, ec2.Port.tcp(6379), 'Workers access to Redis');

    // API and workers can access OpenSearch
    opensearchSg.addIngressRule(apiSg, ec2.Port.tcp(443), 'API access to OpenSearch');
    opensearchSg.addIngressRule(workersSg, ec2.Port.tcp(443), 'Workers access to OpenSearch');

    this.securityGroups = {
      api: apiSg,
      workers: workersSg,
      database: databaseSg,
      redis: redisSg,
      opensearch: opensearchSg,
    };

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
