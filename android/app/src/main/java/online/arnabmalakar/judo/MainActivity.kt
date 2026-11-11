package online.arnabmalakar.judo

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.PackageInfo
import android.content.pm.ActivityInfo
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import android.widget.Toast
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.File
import java.io.BufferedInputStream
import java.io.FileOutputStream
import java.security.SecureRandom
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var appContainer: FrameLayout
    private var lastKeyboardVisibility: Boolean? = null
    private var shareRoom: Room? = null
    private var classroomSocket: Socket? = null
    private var pendingCapture: Intent? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var isPublishingScreen = false
    private var isStoppingScreenShare = false
    private var nativeMicEnabled = false
    private val keepAliveStarted = AtomicBoolean(false)
    private var meetingActiveRequested = false
    private var meetingTitle = "Live class"
    private var notificationPermissionRequestPending = false
    private var updateInProgress = false
    private var pendingUpdateInstall: File? = null

    private data class AppUpdate(val versionCode: Int, val versionName: String, val apkUrl: String, val releaseNotes: String)

    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationPermissionRequestPending = false
        if (meetingActiveRequested) startMeetingKeepAlive()
    }
    private var pendingAudioOutput: String? = null

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

    private val bluetoothPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val output = pendingAudioOutput ?: return@registerForActivityResult
        pendingAudioOutput = null
        if (granted) applyAudioOutput(output)
        else notifyAudioOutput(output, "Allow nearby device access to use a Bluetooth headset.")
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
        createNotificationChannels()
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
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
            addJavascriptInterface(MeetingLifecycleBridge(), "JudoNative")
            webViewClient = JudoWebViewClient()
            webChromeClient = JudoWebChromeClient()
        }
        appContainer = FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(251, 251, 251))
            addView(webView)
        }
        setContentView(appContainer)
        ViewCompat.setOnApplyWindowInsetsListener(appContainer) { _, windowInsets ->
            val safeInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
            if (lastKeyboardVisibility != keyboardVisible) {
                lastKeyboardVisibility = keyboardVisible
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('judo-keyboard',{detail:{visible:$keyboardVisible}}));",
                    null
                )
            }
            val extraTopGap = (10 * resources.displayMetrics.density).roundToInt()
            val params = webView.layoutParams as FrameLayout.LayoutParams
            params.setMargins(safeInsets.left, safeInsets.top + extraTopGap, safeInsets.right, safeInsets.bottom)
            webView.layoutParams = params
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(appContainer)
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        handleShareDeepLink(intent)
        if (savedInstanceState == null) webView.loadUrl(webAppLinkUrl(intent) ?: HOME_URL)
        else webView.restoreState(savedInstanceState)
        requestNotificationPermissionAtStartup()
        checkForAppUpdate()
    }

    private fun requestNotificationPermissionAtStartup() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (hasPermission(Manifest.permission.POST_NOTIFICATIONS)) return

        val preferences = getSharedPreferences(NOTIFICATION_PREFERENCES, MODE_PRIVATE)
        if (preferences.getBoolean(NOTIFICATION_PERMISSION_ASKED, false)) return

        preferences.edit().putBoolean(NOTIFICATION_PERMISSION_ASKED, true).apply()
        notificationPermissionRequestPending = true
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(
            UPDATE_NOTIFICATION_CHANNEL,
            "Judo updates",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "Alerts when a new Judo app update is available." })
    }

    private fun showUpdateNotification(update: AppUpdate) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) return
        val preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
        if (preferences.getInt(NOTIFIED_VERSION, 0) == update.versionCode) return
        val openApp = PendingIntent.getActivity(
            this,
            UPDATE_NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val details = "Version ${update.versionName} is ready to install.${if (update.releaseNotes.isNotBlank()) " ${update.releaseNotes}" else ""}"
        val notification = NotificationCompat.Builder(this, UPDATE_NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_judo)
            .setContentTitle("Judo update available")
            .setContentText(details)
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(this).notify(UPDATE_NOTIFICATION_ID, notification)
        preferences.edit().putInt(NOTIFIED_VERSION, update.versionCode).apply()
    }

    private fun checkForAppUpdate() {
        lifecycleScope.launch {
            val update = withContext(Dispatchers.IO) {
                runCatching {
                    val connection = (URL(UPDATE_INFO_URL).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 8_000
                        readTimeout = 8_000
                        instanceFollowRedirects = false
                    }
                    try {
                        if (connection.responseCode !in 200..299) return@runCatching null
                        val body = connection.inputStream.bufferedReader().use { it.readText() }
                        JSONObject(body).let {
                            AppUpdate(it.getInt("versionCode"), it.getString("versionName"), it.getString("apkUrl"), it.optString("releaseNotes"))
                        }
                    } finally { connection.disconnect() }
                }.getOrNull()
            } ?: return@launch
            val currentVersion = installedVersionCode()
            if (update.versionCode <= currentVersion) return@launch
            val preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
            if (preferences.getInt(DOWNLOADED_VERSION, 0) == update.versionCode) {
                val cachedApk = File(cacheDir, "judo-update-${update.versionCode}.apk")
                if (cachedApk.isFile) {
                    installUpdate(cachedApk)
                    return@launch
                }
            }
            showUpdateNotification(update)
            if (updateInProgress) return@launch
            updateInProgress = true
            Toast.makeText(this@MainActivity, "Downloading Judo ${update.versionName}…", Toast.LENGTH_LONG).show()
            val apk = withContext(Dispatchers.IO) { downloadAndVerifyUpdate(update) }
            updateInProgress = false
            if (apk == null) {
                Toast.makeText(this@MainActivity, "Could not download a valid Judo update. Please try again when connected to the internet.", Toast.LENGTH_LONG).show()
                return@launch
            }
            preferences.edit().putInt(DOWNLOADED_VERSION, update.versionCode).apply()
            AlertDialog.Builder(this@MainActivity)
                .setTitle("Judo ${update.versionName} is ready")
                .setMessage("The update has downloaded.${if (update.releaseNotes.isNotBlank()) "\n\n${update.releaseNotes}" else ""}\n\nAndroid will ask you to confirm the installation.")
                .setPositiveButton("Install update") { _, _ -> installUpdate(apk) }
                .setNegativeButton("Install later", null)
                .show()
        }
    }

    @Suppress("DEPRECATION")
    private fun installedVersionCode(): Long {
        val info = packageManager.getPackageInfo(packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    private fun downloadAndVerifyUpdate(update: AppUpdate): File? = runCatching {
        val apkUri = Uri.parse(update.apkUrl)
        require(apkUri.scheme == "https" && apkUri.host == "judomeet.online") { "Untrusted update host" }
        val connection = (URL(update.apkUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = false
        }
        val apk = File(cacheDir, "judo-update-${update.versionCode}.apk")
        try {
            require(connection.responseCode in 200..299) { "Update download failed" }
            require(connection.contentLengthLong in 1..MAX_UPDATE_SIZE) { "Invalid update file size" }
            BufferedInputStream(connection.inputStream).use { input ->
                FileOutputStream(apk).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= MAX_UPDATE_SIZE) { "Update file is too large" }
                        output.write(buffer, 0, count)
                    }
                }
            }
        } finally { connection.disconnect() }
        @Suppress("DEPRECATION")
        val archive: PackageInfo = packageManager.getPackageArchiveInfo(apk.absolutePath, 0) ?: error("Invalid APK")
        val archiveVersion = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        require(archive.packageName == packageName && archiveVersion == update.versionCode.toLong()) { "APK version does not match update information" }
        apk
    }.getOrNull()

    private fun installUpdate(apk: File) {
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            pendingUpdateInstall = apk
            startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            Toast.makeText(this, "Allow installs for Judo, then return here to continue.", Toast.LENGTH_LONG).show()
            return
        }
        val apkUri = FileProvider.getUriForFile(this, "$packageName.updates", apk)
        startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        })
    }

    override fun onResume() {
        super.onResume()
        val pending = pendingUpdateInstall ?: return
        if (Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()) {
            pendingUpdateInstall = null
            installUpdate(pending)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val appLink = webAppLinkUrl(intent)
        if (appLink != null) webView.loadUrl(appLink) else handleShareDeepLink(intent)
    }

    private fun webAppLinkUrl(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        if (intent.action != Intent.ACTION_VIEW || uri.host != "judomeet.online" || uri.scheme !in setOf("https", "http")) return null
        return uri.buildUpon().scheme("https").build().toString()
    }

    private fun handleShareDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "judo") return
        when (uri.host) {
            "share" -> beginNativeShare(uri)
            "stop-share" -> stopNativeShare()
            "microphone" -> setNativeMicrophoneEnabled(uri.getQueryParameter("enabled")?.toBooleanStrictOrNull() ?: false)
        }
    }

    private fun beginNativeShare(uri: Uri) {
        val server = uri.getQueryParameter("server")?.trimEnd('/')
        val code = uri.getQueryParameter("room")?.trim()
        val name = uri.getQueryParameter("name")?.trim()
        val micEnabled = uri.getQueryParameter("micEnabled")?.toBooleanStrictOrNull() ?: false
        if (server != HOME_URL.trimEnd('/') || code.isNullOrBlank() || name.isNullOrBlank()) {
            notifyWebShare(active = false, error = "Could not start phone sharing. Reopen the meeting in Judo and try again.")
            return
        }
        if (isPublishingScreen) {
            Toast.makeText(this, "Your phone screen is already being shared. Stop it before starting again.", Toast.LENGTH_LONG).show()
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        pendingCapture = Intent().putExtra("server", server).putExtra("room", code).putExtra("name", name).putExtra("micEnabled", micEnabled)
        screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun setNativeMicrophoneEnabled(enabled: Boolean) {
        if (!isPublishingScreen) return
        lifecycleScope.launch {
            try {
                val nativeRoom = shareRoom ?: throw IllegalStateException("Phone sharing is no longer active.")
                if (enabled && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    throw SecurityException("Allow microphone access for Judo in Android settings, then try again.")
                }
                if (!nativeRoom.localParticipant.setMicrophoneEnabled(enabled)) {
                    throw IllegalStateException("Android could not change the microphone. Please try again.")
                }
                nativeMicEnabled = enabled
                notifyWebShare(active = true, micEnabled = nativeMicEnabled)
            } catch (error: Exception) {
                notifyWebShare(active = true, micEnabled = nativeMicEnabled, error = error.message ?: "Could not change the phone microphone.")
            }
        }
    }

    private fun connectAndPublish(request: Intent, permissionData: Intent) {
        val server = request.getStringExtra("server") ?: HOME_URL
        val code = request.getStringExtra("room") ?: ""
        val name = request.getStringExtra("name") ?: "Judo user"
        val micEnabled = request.getBooleanExtra("micEnabled", false)
        lifecycleScope.launch {
            try {
                val tokenResponse = withContext(Dispatchers.IO) { requestRoomToken(server, code, "$name (Android)") }
                val nativeRoom = LiveKit.create(applicationContext)
                nativeRoom.connect(tokenResponse.getString("livekitUrl"), tokenResponse.getString("livekitToken"))
                shareRoom?.disconnect()
                shareRoom = nativeRoom
                connectClassroomSocket(server, tokenResponse.getString("sessionToken"))
                if (micEnabled) {
                    if (!hasPermission(Manifest.permission.RECORD_AUDIO)) throw SecurityException("Allow microphone access for Judo in Android settings, then try again.")
                    if (!nativeRoom.localParticipant.setMicrophoneEnabled(true)) throw IllegalStateException("Android could not start the microphone. Please try again.")
                }
                nativeMicEnabled = micEnabled
                val started = nativeRoom.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(permissionData, onStop = {
                    runOnUiThread { finishNativeScreenShare("Phone screen sharing stopped.") }
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
                nativeMicEnabled = false
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
        if (!isPublishingScreen || isStoppingScreenShare) return
        isStoppingScreenShare = true
        lifecycleScope.launch {
            try {
                shareRoom?.localParticipant?.setScreenShareEnabled(false)
            } catch (_: Exception) {
                // The system may have already ended MediaProjection, which also
                // unpublishes the screen track. Finish cleanup either way.
            }
            finishNativeScreenShare("Phone screen sharing stopped.", stopRequested = true)
        }
    }

    private fun finishNativeScreenShare(message: String, stopRequested: Boolean = false) {
        if (!isPublishingScreen || isStoppingScreenShare && !stopRequested) return
        isStoppingScreenShare = true
        lifecycleScope.launch {
            if (nativeMicEnabled) {
                try { shareRoom?.localParticipant?.setMicrophoneEnabled(false) }
                catch (_: Exception) { }
            }
            isPublishingScreen = false
            isStoppingScreenShare = false
            nativeMicEnabled = false
            // Keep the Android participant and meeting socket connected. Only
            // the screen track and its optional microphone should stop here.
            notifyWebShare(active = false, message = message)
        }
    }

    private fun finishNativeShare(message: String) {
        isPublishingScreen = false
        isStoppingScreenShare = false
        shareRoom?.disconnect()
        shareRoom = null
        classroomSocket?.disconnect()
        classroomSocket = null
        notifyWebShare(active = false, message = message)
        nativeMicEnabled = false
    }

    private fun leaveNativeMeeting() {
        isPublishingScreen = false
        isStoppingScreenShare = false
        shareRoom?.disconnect()
        shareRoom = null
        classroomSocket?.disconnect()
        classroomSocket = null
        nativeMicEnabled = false
    }

    private fun startMeetingKeepAlive() {
        if (!meetingActiveRequested || !keepAliveStarted.compareAndSet(false, true)) return
        if (!hasPermission(Manifest.permission.CAMERA) && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
            keepAliveStarted.set(false)
            Toast.makeText(this, "Allow Judo camera or microphone access to keep a meeting active in the background.", Toast.LENGTH_LONG).show()
            return
        }
        try {
            ContextCompat.startForegroundService(this, Intent(this, MeetingKeepAliveService::class.java)
                .putExtra(MeetingKeepAliveService.EXTRA_CLASS_TITLE, meetingTitle))
        } catch (_: Exception) {
            keepAliveStarted.set(false)
            Toast.makeText(this, "Judo could not keep the meeting active in the background.", Toast.LENGTH_LONG).show()
        }
    }

    private fun notifyWebShare(active: Boolean, error: String? = null, message: String? = null, micEnabled: Boolean? = null) {
        if (!::webView.isInitialized) return
        val detail = JSONObject().put("active", active).apply {
            if (error != null) put("error", error)
            if (message != null) put("message", message)
            if (micEnabled != null) put("micEnabled", micEnabled)
        }
        val script = "window.dispatchEvent(new CustomEvent('judo-native-screen-share',{detail:${detail}}));"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun hasPermission(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun applyAudioOutput(output: String) {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val targetType = when (output) {
                    "speaker" -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    "earpiece" -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    "bluetooth" -> null
                    else -> return
                }
                val device = audioManager.availableCommunicationDevices.firstOrNull { available ->
                    if (output == "bluetooth") available.type in setOf(
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                        AudioDeviceInfo.TYPE_BLE_HEADSET,
                        AudioDeviceInfo.TYPE_HEARING_AID
                    ) else available.type == targetType
                }
                if (device == null) {
                    notifyAudioOutput(output, if (output == "bluetooth") "No Bluetooth audio device is connected." else "That audio output is not available on this device.")
                    return
                }
                if (!audioManager.setCommunicationDevice(device)) {
                    notifyAudioOutput(output, "Android could not switch the audio output.")
                    return
                }
            } else {
                when (output) {
                    "speaker" -> audioManager.isSpeakerphoneOn = true
                    "earpiece" -> audioManager.isSpeakerphoneOn = false
                    "bluetooth" -> {
                        if (!audioManager.isBluetoothScoAvailableOffCall) {
                            notifyAudioOutput(output, "Bluetooth audio is not available on this device.")
                            return
                        }
                        @Suppress("DEPRECATION")
                        audioManager.startBluetoothSco()
                        @Suppress("DEPRECATION")
                        audioManager.isBluetoothScoOn = true
                    }
                    else -> return
                }
            }
            notifyAudioOutput(output)
        } catch (error: Exception) {
            notifyAudioOutput(output, error.message ?: "Android could not switch the audio output.")
        }
    }

    private fun resetAudioOutput() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice()
        @Suppress("DEPRECATION")
        audioManager.isBluetoothScoOn = false
        @Suppress("DEPRECATION")
        audioManager.stopBluetoothSco()
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = false
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    private fun notifyAudioOutput(output: String, error: String? = null) {
        if (!::webView.isInitialized) return
        val detail = JSONObject().put("output", output).put("error", error)
        runOnUiThread { webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('judo-audio-output',{detail:$detail}));", null) }
    }

    private inner class MeetingLifecycleBridge {
        @JavascriptInterface
        fun setScreenViewerFullscreen(active: Boolean, landscape: Boolean) {
            runOnUiThread {
                val host = runCatching { Uri.parse(webView.url ?: HOME_URL).host }.getOrNull()
                if (!isJudoHost(host)) return@runOnUiThread
                if (active) {
                    requestedOrientation = if (landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    else ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                    window.decorView.systemUiVisibility = (android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        or android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                        or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
                } else {
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                }
            }
        }

        @JavascriptInterface
        fun setMeetingActive(active: Boolean, title: String?) {
            // The bridge is available only to Judo's first-party page. Keep this
            // origin check here as well as in the WebView navigation client.
            runOnUiThread {
                val host = runCatching { Uri.parse(webView.url ?: HOME_URL).host }.getOrNull()
                if (!isJudoHost(host)) return@runOnUiThread
                if (active) {
                    meetingActiveRequested = true
                    meetingTitle = title?.trim()?.take(120)?.ifBlank { "Live class" } ?: "Live class"
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
                        if (!notificationPermissionRequestPending) {
                            notificationPermissionRequestPending = true
                            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    } else {
                        startMeetingKeepAlive()
                    }
                } else {
                    meetingActiveRequested = false
                    notificationPermissionRequestPending = false
                    if (keepAliveStarted.compareAndSet(true, false)) {
                        stopService(Intent(this@MainActivity, MeetingKeepAliveService::class.java))
                    }
                    leaveNativeMeeting()
                }
            }
        }

        @JavascriptInterface
        fun setAudioOutput(output: String) {
            runOnUiThread {
                val host = runCatching { Uri.parse(webView.url ?: HOME_URL).host }.getOrNull()
                if (!isJudoHost(host)) return@runOnUiThread
                if (output !in setOf("speaker", "earpiece", "bluetooth")) return@runOnUiThread
                if (output == "bluetooth" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
                    pendingAudioOutput = output
                    bluetoothPermissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
                    return@runOnUiThread
                }
                applyAudioOutput(output)
            }
        }

        @JavascriptInterface
        fun resetAudioOutput() {
            runOnUiThread {
                val host = runCatching { Uri.parse(webView.url ?: HOME_URL).host }.getOrNull()
                if (isJudoHost(host)) this@MainActivity.resetAudioOutput()
            }
        }
    }

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
        leaveNativeMeeting()
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val HOME_URL = "https://judomeet.online/"
        private const val NOTIFICATION_PREFERENCES = "judo_notifications"
        private const val NOTIFICATION_PERMISSION_ASKED = "startup_permission_asked_v4"
        private const val UPDATE_INFO_URL = "https://judomeet.online/android-update.json"
        private const val UPDATE_PREFERENCES = "android_app_updates"
        private const val NOTIFIED_VERSION = "notifiedVersion"
        private const val DOWNLOADED_VERSION = "downloadedVersion"
        private const val UPDATE_NOTIFICATION_CHANNEL = "judo_app_updates"
        private const val UPDATE_NOTIFICATION_ID = 9105
        private const val MAX_UPDATE_SIZE = 200L * 1024L * 1024L
    }
}
