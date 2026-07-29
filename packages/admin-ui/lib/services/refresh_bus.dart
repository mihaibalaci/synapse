import 'package:flutter/foundation.dart';

/// Broadcasts refresh requests from the app bar's refresh button to whichever
/// page is currently mounted. Pages listen and re-fetch their data.
class RefreshBus extends ChangeNotifier {
  int _tick = 0;
  bool _busy = false;

  int get tick => _tick;
  bool get busy => _busy;

  /// Called by the refresh button.
  void request() {
    _tick++;
    notifyListeners();
  }

  /// Pages report fetch state so the button can show progress.
  void setBusy(bool value) {
    if (_busy == value) return;
    _busy = value;
    notifyListeners();
  }
}
