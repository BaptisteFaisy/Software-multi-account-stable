# Conserve l'interface JavaScript exposee a la WebView (sinon R8 la supprime).
-keepclassmembers class com.codexswitch.terminal.MainActivity$CstBridge {
    @android.webkit.JavascriptInterface <methods>;
}
