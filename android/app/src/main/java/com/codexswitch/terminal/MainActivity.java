package com.codexswitch.terminal;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Coque WebView pour Codex Switch Terminal.
 *
 * Charge l'interface web servie par le serveur cst-server (via Tailscale Serve,
 * HTTPS tailnet) et expose le pont {@code window.CstAndroid} attendu par
 * {@code src/platform.ts} (getBaseUrl / getToken / setConfig / openSettings).
 *
 * Le token n'est PAS embarque dans l'APK : l'ecran de connexion web le demande
 * une fois puis le conserve (DOM storage de la WebView). Le pont permet en plus
 * de pre-configurer l'URL/token depuis le natif si besoin (setConfig).
 */
public class MainActivity extends Activity {

    private static final String PREFS = "cst";
    private static final String KEY_BASE = "baseUrl";
    private static final String KEY_TOKEN = "token";

    private WebView webView;
    private SharedPreferences prefs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage : persistance du token
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);           // terminal : pas de pinch-zoom parasite
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new CstBridge(), "CstAndroid");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String host = url.getHost();
                String baseHost = Uri.parse(currentBaseUrl()).getHost();
                // Navigation interne (meme hote) : reste dans la WebView.
                if (host != null && host.equalsIgnoreCase(baseHost)) {
                    return false;
                }
                // Lien externe : ouvre le navigateur systeme.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(currentBaseUrl());
        }
    }

    /** URL a charger : valeur configuree, sinon le serveur par defaut. */
    private String currentBaseUrl() {
        String saved = prefs.getString(KEY_BASE, "");
        return saved.isEmpty() ? getString(R.string.server_url) : saved;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * Pont JS <-> natif. Les noms correspondent au contrat de platform.ts.
     * getBaseUrl/getToken renvoient "" par defaut : le web retombe alors sur
     * l'origine (l'URL chargee) et son ecran de connexion pour saisir le token.
     */
    private class CstBridge {
        @JavascriptInterface
        public String getBaseUrl() {
            return prefs.getString(KEY_BASE, "");
        }

        @JavascriptInterface
        public String getToken() {
            return prefs.getString(KEY_TOKEN, "");
        }

        @JavascriptInterface
        public void setConfig(String baseUrl, String token) {
            prefs.edit()
                    .putString(KEY_BASE, baseUrl == null ? "" : baseUrl.trim())
                    .putString(KEY_TOKEN, token == null ? "" : token.trim())
                    .apply();
        }

        @JavascriptInterface
        public void openSettings() {
            // Reserve : ouvrira un ecran natif de configuration dans une version
            // future. Aujourd'hui la configuration se fait cote web.
        }
    }
}
