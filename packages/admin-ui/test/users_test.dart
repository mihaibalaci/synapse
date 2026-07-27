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

    testWidgets('renders roles section with all roles', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('Admin'), findsWidgets);
      expect(find.text('Team Lead'), findsWidgets);
      expect(find.text('Developer'), findsWidgets);
      expect(find.text('Viewer'), findsOneWidget);
    });

    testWidgets('renders role descriptions', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('Full system access, user management'), findsOneWidget);
      expect(find.text('Capture, search, own data'), findsOneWidget);
    });

    testWidgets('renders users table with sample data', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      expect(find.text('Alice Chen'), findsOneWidget);
      expect(find.text('Bob Park'), findsOneWidget);
      expect(find.text('Carol Singh'), findsOneWidget);
    });

    testWidgets('shows add user dialog on button tap', (tester) async {
      setLargeViewport(tester);
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(buildTestApp(const UsersPage()));
      await tester.pump();

      await tester.tap(find.text('Add User'));
      await tester.pumpAndSettle();

      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(find.text('Create'), findsOneWidget);
    });
  });
}
