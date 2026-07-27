import 'package:go_router/go_router.dart';
import 'pages/dashboard/dashboard_page.dart';
import 'pages/users/users_page.dart';
import 'pages/system/system_page.dart';
import 'pages/activity/activity_page.dart';
import 'widgets/shell_scaffold.dart';

final appRouter = GoRouter(
  initialLocation: '/dashboard',
  routes: [
    ShellRoute(
      builder: (context, state, child) => ShellScaffold(child: child),
      routes: [
        GoRoute(
          path: '/dashboard',
          pageBuilder: (context, state) => const NoTransitionPage(
            child: DashboardPage(),
          ),
        ),
        GoRoute(
          path: '/users',
          pageBuilder: (context, state) => const NoTransitionPage(
            child: UsersPage(),
          ),
        ),
        GoRoute(
          path: '/system',
          pageBuilder: (context, state) => const NoTransitionPage(
            child: SystemPage(),
          ),
        ),
        GoRoute(
          path: '/activity',
          pageBuilder: (context, state) => const NoTransitionPage(
            child: ActivityPage(),
          ),
        ),
      ],
    ),
  ],
);
