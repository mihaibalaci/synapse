import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:synapse_admin/pages/activity/activity_page.dart';

import 'helpers.dart';

void main() {
  void setLargeViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1920, 1080);
    tester.view.devicePixelRatio = 1.0;
  }

  group('ActivityPage', () {
    testWidgets('renders header', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const ActivityPage()));
      await tester.pump();

      expect(find.text('Activity Log'), findsOneWidget);
    });

    testWidgets('shows live indicator', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const ActivityPage()));
      await tester.pump();

      expect(find.text('Live'), findsOneWidget);
      expect(find.text('(5s refresh)'), findsOneWidget);
    });

    testWidgets('shows empty state initially', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const ActivityPage()));
      // Wait for the async refresh to complete
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();

      expect(find.text('No sessions captured yet'), findsOneWidget);
    });
  });
}
