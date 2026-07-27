import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:synapse_admin/services/api_service.dart';
import 'package:synapse_admin/services/auth_service.dart';

/// Mock API service that returns empty data without making HTTP calls.
class MockApiService extends ApiService {
  MockApiService() : super(auth: AuthService());

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/health/ready') {
      return {'status': 'ready', 'checks': {'database': 'ok', 'redis': 'ok', 'objectStorage': 'ok', 'queue': 'ok'}};
    }
    if (path == '/api/v1/stats') {
      return {
        'organization': 'test-org',
        'timestamp': DateTime.now().toIso8601String(),
        'counts': {'sessions': 42, 'chunks': 180, 'searchableChunks': 150, 'facts': 88, 'clusters': 5, 'knowledgeRecords': 12, 'graphNodes': 200},
        'processing': {'activeSessions': 2, 'searchable': 40, 'blocked': 0, 'failed': 0, 'byStatus': {'searchable': 40, 'pending': 2}},
        'queues': {'sessionProcessing': 1, 'factExtraction': 0, 'knowledgeExtraction': 0, 'deduplication': 0, 'graphIndexing': 0, 'searchIndexing': 0, 'captureProcessing': 0, 'total': 1},
        'recentActivity': [],
      };
    }
    if (path == '/api/v1/stats/learning') {
      return {
        'metrics': {
          'period': {'from': '2026-07-20T00:00:00Z', 'to': '2026-07-27T00:00:00Z'},
          'inline': {'factsExtracted': 120, 'opinionsReinforced': 5, 'opinionsWeakened': 1, 'opinionsContradicted': 0, 'observationsTriggered': 30},
          'reflect': {'reflectCalls': 15, 'highConfidenceAnswers': 8, 'insightsWrittenBack': 4, 'sourcesBosted': 60},
          'health': {'isLearning': true, 'confidenceTrend': 0.72, 'compressionRatio': 0.0, 'observationCoverage': 0.35},
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
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
    return {'triggered': true, 'result': {'opinionsReinforced': 2, 'observationsRefreshed': 1, 'observationsDiscovered': 3}};
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
      Provider<ApiService>.value(value: api),
    ],
    child: MaterialApp(
      home: MediaQuery(
        data: const MediaQueryData(size: Size(1920, 1080)),
        child: Scaffold(
          body: SingleChildScrollView(
            child: SizedBox(
              width: 1920,
              child: child,
            ),
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
      GoRoute(path: '/dashboard', builder: (_, __) => const Placeholder()),
      GoRoute(path: '/users', builder: (_, __) => const Placeholder()),
      GoRoute(path: '/system', builder: (_, __) => const Placeholder()),
      GoRoute(path: '/activity', builder: (_, __) => const Placeholder()),
    ],
  );

  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AuthService>.value(value: auth),
      Provider<ApiService>.value(value: api),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}
