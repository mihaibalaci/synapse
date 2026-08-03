import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:synapse_admin/pages/users/users_page.dart';
import 'helpers.dart';

void main() {
  void setLargeViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1920, 1080);
    tester.view.devicePixelRatio = 1.0;
  }

  group('UsersPage', () {
    testWidgets('renders header with Add User button', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('Users & Roles'), findsOneWidget);
      expect(find.text('Add User'), findsOneWidget);
    });

    testWidgets('renders roles from API', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('Admin'), findsWidgets);
      expect(find.text('Developer'), findsWidgets);
      expect(find.text('Viewer'), findsOneWidget);
    });

    testWidgets('renders users from API', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('admin@synapse.local'), findsOneWidget);
      expect(find.text('dev@company.com'), findsOneWidget);
    });

    testWidgets('shows add user dialog on button tap', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      await tester.tap(find.text('Add User'));
      await tester.pumpAndSettle();

      expect(find.text('Display Name'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(find.text('Create'), findsOneWidget);
    });
  });
}
