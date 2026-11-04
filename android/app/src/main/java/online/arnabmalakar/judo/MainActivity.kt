package online.arnabmalakar.judo

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var shareRoom: Room? = null
    private var classroomSocket: Socket? = null
    private var pendingCapture: Intent? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var isPublishingScreen = false

    private val screenCaptureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            pendingCapture = null
            notifyWebShare(active = false)
            return@registerForActivityResult
        }
        val request = pendingCapture ?: return@registerForActivityResult
        pendingCapture = null
        connectAndPublish(request, data)
    }

    private val webPermissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val request = pendingWebPermission ?: return@registerForActivityResult
        pendingWebPermission = null
        val resources = request.resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> grants[Manifest.permission.CAMERA] == true || hasPermission(Manifest.permission.CAMERA)
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> grants[Manifest.permission.RECORD_AUDIO] == true || hasPermission(Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }
        if (resources.size == request.resources.size) request.grant(resources.toTypedArray()) else request.deny()
    }

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingFileChooser?.onReceiveValue(uris.toTypedArray())
        pendingFileChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        window.decorView.setBackgroundColor(android.graphics.Color.rgb(251, 251, 251))
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(android.graphics.Color.rgb(251, 251, 251))
            clipToPadding = true
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.safeBrowsingEnabled = true
            settings.userAgentString = "${settings.userAgentString} JudoAndroidApp"
            webViewClient = JudoWebViewClient()
            webChromeClient = JudoWebChromeClient()
        }
        setContentView(webView)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val safeInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(safeInsets.left, safeInsets.top, safeInsets.right, safeInsets.bottom)
            windowInsets
        }
        ViewCompat.requestApplyInsets(webView)
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        handleShareDeepLink(intent)
        if (savedInstanceState == null) webView.loadUrl(HOME_URL)
        else webView.restoreState(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareDeepLink(intent)
    }

    private fun handleShareDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "judo") return
        when (uri.host) {
            "share" -> beginNativeShare(uri)
            "stop-share" -> stopNativeShare()
        }
    }

    private fun beginNativeShare(uri: Uri) {
        val server = uri.getQueryParameter("server")?.trimEnd('/')
        val code = uri.getQueryParameter("room")?.trim()
        val name = uri.getQueryParameter("name")?.trim()
        if (server != HOME_URL.trimEnd('/') || code.isNullOrBlank() || name.isNullOrBlank()) {
            notifyWebShare(active = false, error = "Could not start phone sharing. Reopen the meeting in Judo and try again.")
            return
        }
        if (isPublishingScreen) {
            Toast.makeText(this, "Your phone screen is already being shared. Stop it before starting again.", Toast.LENGTH_LONG).show()
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        pendingCapture = Intent().putExtra("server", server).putExtra("room", code).putExtra("name", name)
        screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun connectAndPublish(request: Intent, permissionData: Intent) {
        val server = request.getStringExtra("server") ?: HOME_URL
        val code = request.getStringExtra("room") ?: ""
        val name = request.getStringExtra("name") ?: "Judo user"
        lifecycleScope.launch {
            try {
                val tokenResponse = withContext(Dispatchers.IO) { requestRoomToken(server, code, "$name (Android)") }
                val nativeRoom = LiveKit.create(applicationContext)
                nativeRoom.connect(tokenResponse.getString("livekitUrl"), tokenResponse.getString("livekitToken"))
                shareRoom?.disconnect()
                shareRoom = nativeRoom
                connectClassroomSocket(server, tokenResponse.getString("sessionToken"))
                val started = nativeRoom.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(permissionData, onStop = {
                    runOnUiThread { finishNativeShare("Phone screen sharing stopped.") }
                }))
                if (!started) throw IllegalStateException("Android could not start screen capture. Please try again.")
                isPublishingScreen = true
                notifyWebShare(active = true)
            } catch (error: Exception) {
                shareRoom?.disconnect()
                shareRoom = null
                classroomSocket?.disconnect()
                classroomSocket = null
                isPublishingScreen = false
                notifyWebShare(active = false, error = error.message ?: "Could not publish your phone screen to this meeting.")
            }
        }
    }

    private fun connectClassroomSocket(server: String, sessionToken: String) {
        classroomSocket?.disconnect()
        val options = IO.Options().apply {
            auth = mapOf("token" to sessionToken)
            reconnection = true
            reconnectionAttempts = 12
        }
        val socket = IO.socket(server, options)
        classroomSocket = socket
        socket.on(Socket.EVENT_CONNECT, Emitter.Listener { socket.emit("board:sync") })
        socket.on("meeting:kicked", Emitter.Listener { args ->
            runOnUiThread {
                val message = (args.firstOrNull() as? JSONObject)?.optString("message") ?: "The host removed the phone share from this meeting."
                finishNativeShare(message)
            }
        })
        socket.on("meeting:ended", Emitter.Listener { args ->
            runOnUiThread {
                val message = (args.firstOrNull() as? JSONObject)?.optString("message") ?: "This meeting has ended."
                finishNativeShare(message)
            }
        })
        socket.connect()
    }

    private fun requestRoomToken(server: String, code: String, name: String): JSONObject {
        val encodedCode = java.net.URLEncoder.encode(code, Charsets.UTF_8.name())
        val connection = (URL("$server/api/rooms/$encodedCode/join").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            val guestKey = ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
            val body = JSONObject().put("displayName", name).put("guestKey", guestKey).toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val statusCode = connection.responseCode
            val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
            val response = stream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
            if (statusCode !in 200..299) throw IllegalStateException(response.optString("error", "Could not join this meeting."))
            return response
        } finally {
            connection.disconnect()
        }
    }

    private fun stopNativeShare() {
        if (!isPublishingScreen) return
        lifecycleScope.launch {
            try { shareRoom?.localParticipant?.setScreenShareEnabled(false) }
            catch (error: Exception) { notifyWebShare(active = false, error = error.message ?: "Could not stop phone screen sharing.") }
            finishNativeShare("Phone screen sharing stopped.")
        }
    }

    private fun finishNativeShare(message: String) {
        isPublishingScreen = false
        shareRoom?.disconnect()
        shareRoom = null
        classroomSocket?.disconnect()
        classroomSocket = null
        notifyWebShare(active = false, message = message)
    }

    private fun notifyWebShare(active: Boolean, error: String? = null, message: String? = null) {
        if (!::webView.isInitialized) return
        val detail = JSONObject().put("active", active).apply {
            if (error != null) put("error", error)
            if (message != null) put("message", message)
        }
        val script = "window.dispatchEvent(new CustomEvent('judo-native-screen-share',{detail:${detail}}));"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun hasPermission(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private inner class JudoWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = routeUri(request.url)
        @Suppress("DEPRECATION")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = routeUri(Uri.parse(url))

        private fun routeUri(uri: Uri): Boolean {
            if (uri.scheme == "judo") {
                if (!isJudoHost(Uri.parse(webView.url ?: HOME_URL).host)) return true
                handleShareDeepLink(Intent(Intent.ACTION_VIEW, uri))
                return true
            }
            if (uri.scheme == "https" && isJudoHost(uri.host)) return false
            if (uri.scheme == "http" || uri.scheme == "https") {
                try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) { }
                return true
            }
            return true
        }
    }

    private inner class JudoWebChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                if (!isJudoHost(Uri.parse(request.origin.toString()).host)) {
                    request.deny()
                    return@runOnUiThread
                }
                val missing = buildList {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources && !hasPermission(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources && !hasPermission(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
                }
                if (missing.isEmpty()) request.grant(request.resources) else {
                    pendingWebPermission?.deny()
                    pendingWebPermission = request
                    webPermissionsLauncher.launch(missing.toTypedArray())
                }
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingWebPermission == request) pendingWebPermission = null
        }

        override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            pendingFileChooser?.onReceiveValue(null)
            pendingFileChooser = callback
            fileChooserLauncher.launch("*/*")
            return true
        }
    }

    private fun isJudoHost(host: String?) = host == "judomeet.online" || host?.endsWith(".judomeet.online") == true

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        pendingWebPermission?.deny()
        pendingWebPermission = null
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        classroomSocket?.disconnect()
        classroomSocket = null
        shareRoom?.disconnect()
        shareRoom = null
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val HOME_URL = "https://judomeet.online/"
    }
}
