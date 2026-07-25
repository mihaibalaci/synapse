/**
 * Data Stack
 *
 * All stateful data services:
 *   - RDS PostgreSQL 16 (with pgvector extension)
 *   - ElastiCache Redis 7 Cluster
 *   - S3 Bucket (raw session storage)
 *   - OpenSearch domain (BM25 full-text search)
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  stage: string;
  vpc: ec2.Vpc;
  securityGroups: {
    database: ec2.SecurityGroup;
    redis: ec2.SecurityGroup;
    opensearch: ec2.SecurityGroup;
  };
}

export class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseCluster;
  public readonly redis: elasticache.CfnReplicationGroup;
  public readonly bucket: s3.Bucket;
  public readonly openSearchDomain: opensearch.Domain;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { stage, vpc, securityGroups } = props;
    const isProd = stage === 'prod';

    // ─── S3 Bucket (Raw Session Storage) ─────────────────────────────────────

    this.bucket = new s3.Bucket(this, 'RawSessionsBucket', {
      bucketName: `recall-raw-${stage}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          // Move to Infrequent Access after 90 days
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(365) },
          ],
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ─── RDS PostgreSQL (pgvector) ───────────────────────────────────────────

    this.database = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_1,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: isProd
          ? ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.XLARGE)
          : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      }),
      readers: isProd
        ? [
            rds.ClusterInstance.provisioned('Reader1', {
              instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.XLARGE),
            }),
            rds.ClusterInstance.provisioned('Reader2', {
              instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
            }),
          ]
        : [],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [securityGroups.database],
      defaultDatabaseName: 'recall',
      storageEncrypted: true,
      deletionProtection: isProd,
      backup: {
        retention: cdk.Duration.days(isProd ? 30 : 7),
      },
      monitoringInterval: cdk.Duration.seconds(isProd ? 30 : 60),
      cloudwatchLogsExports: ['postgresql'],
      parameters: {
        'shared_preload_libraries': 'pg_stat_statements,vector',
      },
    });

    // ─── ElastiCache Redis ───────────────────────────────────────────────────

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Redis subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      cacheSubnetGroupName: `recall-redis-${stage}`,
    });

    this.redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `Recall Redis - ${stage}`,
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: isProd ? 'cache.r7g.large' : 'cache.t4g.micro',
      numCacheClusters: isProd ? 3 : 1,
      automaticFailoverEnabled: isProd,
      multiAzEnabled: isProd,
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      securityGroupIds: [securityGroups.redis.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      snapshotRetentionLimit: isProd ? 7 : 1,
      port: 6379,
    });

    this.redis.addDependency(redisSubnetGroup);

    // ─── OpenSearch Domain ───────────────────────────────────────────────────

    this.openSearchDomain = new opensearch.Domain(this, 'SearchDomain', {
      domainName: `recall-search-${stage}`,
      version: opensearch.EngineVersion.OPENSEARCH_2_11,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      securityGroups: [securityGroups.opensearch],
      capacity: {
        dataNodes: isProd ? 3 : 1,
        dataNodeInstanceType: isProd ? 'r6g.large.search' : 't3.small.search',
        masterNodes: isProd ? 3 : 0,
        masterNodeInstanceType: isProd ? 'r6g.large.search' : undefined,
      },
      ebs: {
        volumeSize: isProd ? 200 : 20,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      zoneAwareness: isProd ? { availabilityZoneCount: 3 } : undefined,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.clusterEndpoint.hostname,
    });
    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redis.attrPrimaryEndPointAddress,
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
    });
    new cdk.CfnOutput(this, 'OpenSearchEndpoint', {
      value: this.openSearchDomain.domainEndpoint,
    });
  }
}
