import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:synapse_admin/pages/system/system_page.dart';

import 'helpers.dart';

void main() {
  void setLargeViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1920, 1200);
    tester.view.devicePixelRatio = 1.0;
  }

  group('SystemPage', () {
    testWidgets('renders header', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const SystemPage()));
      await tester.pump();

      expect(find.text('System Components'), findsOneWidget);
    });

    testWidgets('renders all component cards', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const SystemPage()));
      await tester.pump();

      expect(find.text('PostgreSQL 16'), findsOneWidget);
      expect(find.text('Redis 7'), findsOneWidget);
      expect(find.text('Object Storage'), findsOneWidget);
      expect(find.text('API Server'), findsOneWidget);
      expect(find.text('Worker Service'), findsOneWidget);
      expect(find.text('Learning Loop'), findsOneWidget);
    });

    testWidgets('shows component descriptions', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const SystemPage()));
      await tester.pump();

      expect(find.text('pgvector + FTS + graph + RLS'), findsOneWidget);
      expect(find.text('BullMQ + cache + rate limits'), findsOneWidget);
    });

    testWidgets('renders data flow section', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const SystemPage()));
      await tester.pump();

      expect(find.text('Data Flow'), findsOneWidget);
      expect(find.text('Capture'), findsOneWidget);
      expect(find.text('Embed'), findsOneWidget);
      expect(find.text('Index'), findsOneWidget);
    });
  });
}
