import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:synapse_admin/services/api_service.dart';
import 'package:synapse_admin/services/auth_service.dart';
import 'package:synapse_admin/services/refresh_bus.dart';

/// Mock API service that returns empty data without making HTTP calls.
class MockApiService extends ApiService {
  MockApiService() : super(auth: AuthService());

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/health/ready') {
      return {
        'status': 'ready',
        'checks': {
          'database': 'ok',
          'redis': 'ok',
          'objectStorage': 'ok',
          'queue': 'ok',
        },
      };
    }
    if (path == '/api/v1/stats') {
      return {
        'organization': 'test-org',
        'timestamp': DateTime.now().toIso8601String(),
        'counts': {
          'sessions': 42,
          'chunks': 180,
          'searchableChunks': 150,
          'facts': 88,
          'clusters': 5,
          'knowledgeRecords': 12,
          'graphNodes': 200,
        },
        'processing': {
          'activeSessions': 2,
          'searchable': 40,
          'blocked': 0,
          'failed': 0,
          'byStatus': {'searchable': 40, 'pending': 2},
        },
        'queues': {
          'sessionProcessing': 1,
          'factExtraction': 0,
          'knowledgeExtraction': 0,
          'deduplication': 0,
          'graphIndexing': 0,
          'searchIndexing': 0,
          'captureProcessing': 0,
          'total': 1,
        },
        'recentActivity': [],
      };
    }
    if (path == '/api/v1/stats/metrics') {
      return {
        'cache': {
          'hits': 340,
          'misses': 60,
          'hitRate': 85.0,
          'evictions': 2,
          'size': 128,
        },
        'retrieval': {
          'totalQueries': 400,
          'avgLatencyMs': 42,
          'p95LatencyMs': 90,
          'concurrentNow': 3,
          'peakConcurrent': 11,
        },
        'ingestion': {
          'sessionsProcessed': 42,
          'chunksCreated': 180,
          'factsExtracted': 88,
          'segmentations': 42,
          'embeddingsGenerated': 180,
          'deduplicationsRun': 4,
          'graphUpdates': 200,
          'searchIndexed': 150,
        },
        'storage': {
          'pgActiveConns': 4,
          'pgMaxConns': 20,
          'redisConns': 2,
          'from': 0,
          's3Puts': 42,
          's3Gets': 15,
        },
        'errors': {
          'total': 0,
          'last5min': 0,
          'retrieval': 0,
          'ingestion': 0,
          'storage': 0,
        },
      };
    }
    if (path == '/api/v1/stats/learning') {
      return {
        'metrics': {
          'period': {
            'from': '2026-07-20T00:00:00Z',
            'to': '2026-07-27T00:00:00Z',
          },
          'inline': {
            'factsExtracted': 120,
            'opinionsReinforced': 5,
            'opinionsWeakened': 1,
            'opinionsContradicted': 0,
            'observationsTriggered': 30,
          },
          'reflect': {
            'reflectCalls': 15,
            'highConfidenceAnswers': 8,
            'insightsWrittenBack': 4,
            'sourcesBosted': 60,
          },
          'health': {
            'isLearning': true,
            'confidenceTrend': 0.72,
            'compressionRatio': 0.0,
            'observationCoverage': 0.35,
          },
        },
        'health': {'healthy': true, 'reasons': []},
        'config': {
          'inlineReinforcementEnabled': true,
          'reflectWriteBackEnabled': true,
          'sourceBoostEnabled': true,
          'writeBackMinConfidence': 'high',
          'maxInsightsPerReflect': 3,
          'observationRefreshDelay': 30,
        },
      };
    }
    return {};
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    return {
      'triggered': true,
      'result': {
        'opinionsReinforced': 2,
        'observationsRefreshed': 1,
        'observationsDiscovered': 3,
      },
    };
  }
}

/// Builds a test app wrapping the widget in providers and a scrollable surface.
/// Uses a large surface size to avoid overflow issues in tests.
Widget buildTestApp(Widget child, {bool useRouter = false}) {
  final auth = AuthService()..devLogin();
  final api = MockApiService();

  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AuthService>.value(value: auth),
      ChangeNotifierProvider<RefreshBus>(create: (_) => RefreshBus()),
      Provider<ApiService>.value(value: api),
    ],
    child: MaterialApp(
      home: MediaQuery(
        data: const MediaQueryData(size: Size(1920, 1080)),
        child: Scaffold(
          body: SingleChildScrollView(
            child: SizedBox(width: 1920, child: child),
          ),
        ),
      ),
    ),
  );
}

/// Builds a test app with GoRouter so ShellScaffold can access GoRouterState.
Widget buildRoutedTestApp(String initialPath) {
  final auth = AuthService()..devLogin();
  final api = MockApiService();

  final router = GoRouter(
    initialLocation: initialPath,
    routes: [
      GoRoute(path: '/dashboard', builder: (_, _) => const Placeholder()),
      GoRoute(path: '/users', builder: (_, _) => const Placeholder()),
      GoRoute(path: '/system', builder: (_, _) => const Placeholder()),
      GoRoute(path: '/activity', builder: (_, _) => const Placeholder()),
    ],
  );

  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AuthService>.value(value: auth),
      ChangeNotifierProvider<RefreshBus>(create: (_) => RefreshBus()),
      Provider<ApiService>.value(value: api),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}
