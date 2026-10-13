package dev.lux.local

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var chooser: ValueCallback<Array<Uri>>? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        LuxLocal.appContext = applicationContext
        LuxLocal.activity = this
        askOnce()
        Sync.ensureScheduled(this)   // keeps syncing (and notifying) after this Activity is gone
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Anything that is not the app's own server (links in an email) goes to the system browser.
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.url.host == "127.0.0.1") return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, r.url)) }
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        // <input type=file> (attachments, inline images) needs the host to show a picker.
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = cb
                return try { startActivityForResult(p.createIntent(), 1); true }
                catch (e: Exception) { chooser = null; false }
            }
        }
        web.setBackgroundColor(getColor(R.color.app_background))   // no white flash while the server boots
        setContentView(web)
        // Compiling the app and opening SQLite can take a few seconds on a cold start: not on the UI thread.
        // start() is idempotent: if this process already runs the server (the Activity was only recreated), it returns its port.
        Thread {
            val port = LuxLocal.start(filesDir.path)
            val token = if (port > 0) Sync.token(this) else ""
            // The secret rides in the fragment (never sent to the server); main.js puts it on every request.
            runOnUiThread { if (port < 0) finish() else web.loadUrl("http://127.0.0.1:$port/#t=$token") }
        }.start()
    }

    // Para la página: trae un adjunto del servidor local y lo abre con la app que lo gestione (un .ics, con el calendario).
    private inner class Bridge {
        @android.webkit.JavascriptInterface
        fun openFile(url: String, name: String) {
            if (!url.startsWith("http://127.0.0.1:")) return
            Thread {
                try {
                    val safe = name.replace('/', '_').replace('\\', '_').trimStart('.').ifEmpty { "adjunto" }
                    val dir = java.io.File(cacheDir, "open").apply { mkdirs() }
                    val out = java.io.File(dir, safe)
                    val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    c.setRequestProperty("X-Mail-Token", Sync.token(this@MainActivity))
                    c.inputStream.use { i -> out.outputStream().use { o -> i.copyTo(o) } }
                    val uri = Uri.parse("content://${OpenProvider.AUTHORITY}/" + Uri.encode(safe))
                    val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, OpenProvider.mime(safe))
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        // un .ics va derecho a la app Calendar si está instalada; si no, a quien lo sepa abrir
                        try { startActivity(Intent(i).setPackage(if (safe.endsWith(".ics", true)) "dev.lux.calendar" else null)) }
                        catch (e: android.content.ActivityNotFoundException) { startActivity(i) }
                    } catch (e: android.content.ActivityNotFoundException) { toast("No hay ninguna app para abrir $safe") }
                } catch (e: Exception) { toast("No se pudo abrir el adjunto") }
            }.start()
        }
    }

    private fun toast(msg: String) = runOnUiThread { android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show() }

    // First launch only: notification permission (Android 13+) and exemption from battery optimisation,
    // without which Doze delays the background sync by tens of minutes.
    private fun askOnce() {
        val prefs = getSharedPreferences("luxlocal", MODE_PRIVATE)
        if (prefs.getBoolean("asked", false)) return
        prefs.edit().putBoolean("asked", true).apply()
        if (android.os.Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        val pm = getSystemService(android.os.PowerManager::class.java)
        if (code == 2 && !pm.isIgnoringBatteryOptimizations(packageName))
            runCatching { startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
    }

    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        if (code == LuxLocal.PICK) LuxLocal.onPickResult(result, data)
        else if (code == 1) { chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); chooser = null }
        else super.onActivityResult(code, result, data)
    }

    // Apps that sync real folders (Drive) need "All files access" (Android 11+); asked once. Off here (res/values/config.xml).
    override fun onResume() {
        super.onResume()
        if (resources.getBoolean(R.bool.needs_all_files) && android.os.Build.VERSION.SDK_INT >= 30 &&
            !android.os.Environment.isExternalStorageManager() && !getSharedPreferences("luxlocal", MODE_PRIVATE).getBoolean("askedFiles", false)) {
            getSharedPreferences("luxlocal", MODE_PRIVATE).edit().putBoolean("askedFiles", true).apply()
            runCatching { startActivity(Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
        }
    }

    override fun onDestroy() { if (LuxLocal.activity === this) LuxLocal.activity = null; super.onDestroy() }

    // The page decides what "back" means (close dialog / tab); it answers true if it handled it.
    @Deprecated("fine for a plain Activity")
    override fun onBackPressed() {
        web.evaluateJavascript("window.luxBack ? window.luxBack() : false") { handled ->
            if (handled != "true") super.onBackPressed()
        }
    }

    // The server is deliberately NOT stopped when the Activity finishes: the process outlives it, and the next
    // launch reuses the running server (restarting Lux inside the same process is not supported).
}
