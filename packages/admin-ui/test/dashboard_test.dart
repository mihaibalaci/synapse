import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:synapse_admin/pages/dashboard/dashboard_page.dart';
import 'package:synapse_admin/services/api_service.dart';
import 'package:synapse_admin/services/auth_service.dart';

import 'helpers.dart';

void main() {
  group('DashboardPage', () {
    setUp(() {
      // Use a large surface to avoid overflow in tests
      TestWidgetsFlutterBinding.ensureInitialized();
    });

    testWidgets('renders header and status chip', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('Live Dashboard'), findsOneWidget);
    });

    testWidgets('renders stat cards section', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      // Stat card labels (some may appear in other panels too)
      expect(find.text('Chunks'), findsWidgets);
      expect(find.text('Graph Nodes'), findsOneWidget);
      expect(find.text('Learning'), findsOneWidget);
    });

    testWidgets('renders data sources panel with all sources', (tester) async {
      tester.view.physicalSize = const Size(1920, 2000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('Data Sources'), findsOneWidget);
      expect(find.text('Kiro'), findsOneWidget);
      expect(find.text('Cursor'), findsOneWidget);
      expect(find.text('Claude Desktop'), findsOneWidget);
      expect(find.text('Windsurf'), findsOneWidget);
      expect(find.text('CLI'), findsOneWidget);
      expect(find.text('Slack Bot'), findsOneWidget);
      expect(find.text('Terminal Daemon'), findsOneWidget);
      expect(find.text('Browser Extension'), findsOneWidget);
      expect(find.text('Git Hooks'), findsOneWidget);
      expect(find.text('Meeting Transcripts'), findsOneWidget);
    });

    testWidgets('data sources shows status legend', (tester) async {
      tester.view.physicalSize = const Size(1920, 2000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('Active'), findsWidgets);
      expect(find.text('Configured'), findsOneWidget);
      expect(find.text('Planned'), findsOneWidget);
    });

    testWidgets('data sources shows integration types', (tester) async {
      tester.view.physicalSize = const Size(1920, 2000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('IDE Plugin (MCP)'), findsNWidgets(4));
      expect(find.text('Terminal Tool'), findsOneWidget);
      expect(find.text('Chat Integration'), findsOneWidget);
      expect(find.text('Ambient Capture'), findsNWidgets(3));
      expect(find.text('VCS Integration'), findsOneWidget);
    });

    testWidgets('renders learning loop panel', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('Learning Loop'), findsOneWidget);
      expect(find.text('Last 7 days'), findsOneWidget);
    });

    testWidgets('renders queue depths panel', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const DashboardPage()));
      await tester.pump();

      expect(find.text('Queue Depths'), findsOneWidget);
    });
  });
}
