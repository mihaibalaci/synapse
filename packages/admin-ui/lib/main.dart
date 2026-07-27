import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'router.dart';

void main() {
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthService()),
        ProxyProvider<AuthService, ApiService>(
          update: (_, auth, __) => ApiService(auth: auth),
        ),
      ],
      child: const SynapseAdminApp(),
    ),
  );
}

class SynapseAdminApp extends StatelessWidget {
  const SynapseAdminApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Synapse Admin',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(Brightness.dark),
      routerConfig: appRouter,
    );
  }

  ThemeData _buildTheme(Brightness brightness) {
    final base = ThemeData(
      brightness: brightness,
      useMaterial3: true,
      colorSchemeSeed: const Color(0xFF6366F1), // Indigo
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
      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
      ),
    );
  }
}
