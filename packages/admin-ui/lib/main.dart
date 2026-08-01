import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';

import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/refresh_bus.dart';
import 'router.dart';

void main() {
  final auth = AuthService();
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthService>.value(value: auth),
        ChangeNotifierProvider(create: (_) => RefreshBus()),
        ProxyProvider<AuthService, ApiService>(
          update: (_, auth, prev) => ApiService(auth: auth),
        ),
      ],
      child: SynapseAdminApp(auth: auth),
    ),
  );
}

class SynapseAdminApp extends StatefulWidget {
  const SynapseAdminApp({super.key, required this.auth});
  final AuthService auth;

  @override
  State<SynapseAdminApp> createState() => _SynapseAdminAppState();
}

class _SynapseAdminAppState extends State<SynapseAdminApp> {
  late final _router = buildRouter(widget.auth);

  @override
  void initState() {
    super.initState();
    widget.auth.initialize();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Synapse Admin',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(Brightness.dark),
      routerConfig: _router,
    );
  }

  ThemeData _buildTheme(Brightness brightness) {
    final base = ThemeData(
      brightness: brightness,
      useMaterial3: true,
      colorSchemeSeed: const Color(0xFF6366F1),
    );
    return base.copyWith(
      textTheme: GoogleFonts.interTextTheme(base.textTheme),
      cardTheme: CardThemeData(
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: brightness == Brightness.dark
                ? Colors.white.withValues(alpha: 0.1)
                : Colors.black.withValues(alpha: 0.08),
          ),
        ),
      ),
      appBarTheme: const AppBarTheme(centerTitle: false, elevation: 0),
    );
  }
}
