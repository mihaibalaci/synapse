import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:synapse_admin/widgets/stat_card.dart';

import 'helpers.dart';

void main() {
  group('StatCard Widget', () {
    testWidgets('renders label and value', (tester) async {
      await tester.pumpWidget(buildTestApp(
        const StatCard(label: 'Sessions', value: '1,234'),
      ));
      await tester.pump();

      expect(find.text('Sessions'), findsOneWidget);
      expect(find.text('1,234'), findsOneWidget);
    });

    testWidgets('renders subtitle when provided', (tester) async {
      await tester.pumpWidget(buildTestApp(
        const StatCard(label: 'Chunks', value: '500', subtitle: '320 searchable'),
      ));
      await tester.pump();

      expect(find.text('320 searchable'), findsOneWidget);
    });

    testWidgets('renders icon when provided', (tester) async {
      await tester.pumpWidget(buildTestApp(
        const StatCard(label: 'Test', value: '0', icon: Icons.star),
      ));
      await tester.pump();

      expect(find.byIcon(Icons.star), findsOneWidget);
    });

    testWidgets('applies custom value color', (tester) async {
      await tester.pumpWidget(buildTestApp(
        const StatCard(label: 'Status', value: 'Active', valueColor: Colors.green),
      ));
      await tester.pump();

      final textWidget = tester.widget<Text>(find.text('Active'));
      expect(textWidget.style?.color, Colors.green);
    });
  });

  group('App Navigation (via router)', () {
    testWidgets('router initializes to dashboard', (tester) async {
      await tester.pumpWidget(buildRoutedTestApp('/dashboard'));
      await tester.pumpAndSettle();

      // Should render without crashing
      expect(find.byType(Placeholder), findsOneWidget);
    });
  });
}
