package at.schoolemergency.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

const val CH_ALERTS = "alerts"
const val CH_MONITOR = "monitor"
const val NOTIF_MONITOR = 100
const val NOTIF_ALERT = 200

class AlertService : android.app.Service() {

    companion object {
        fun start(ctx: Context) {
            val intent = Intent(ctx, AlertService::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AlertService::class.java))
        }
    }

    @Volatile
    private var running = false
    private var worker: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannels(this)
        val notif = monitorNotification(this)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_MONITOR, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_MONITOR, notif)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = getSharedPreferences("se", MODE_PRIVATE)
        val base = prefs.getString("base", "") ?: ""
        val token = prefs.getString("token", "") ?: ""
        if (worker == null && base.isNotEmpty() && token.isNotEmpty()) {
            worker = Thread { runLoop(base, token) }.apply {
                isDaemon = true
                start()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        AlarmPlayer.stop()
        super.onDestroy()
    }

    private fun runLoop(base: String, token: String) {
        while (running) {
            try {
                connectOnce(base, token)
            } catch (_: Exception) {
            }
            if (running) {
                try {
                    Thread.sleep(3000)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
    }

    private fun connectOnce(base: String, token: String) {
        val conn = URL(base.trimEnd('/') + "/api/alerts/stream?token=" + token).openConnection() as HttpURLConnection
        conn.connectTimeout = 10000
        conn.readTimeout = 0
        val stream = conn.inputStream
        try {
            val reader = BufferedReader(InputStreamReader(stream, Charsets.UTF_8))
            var event = ""
            val data = StringBuilder()
            while (running) {
                val line = reader.readLine() ?: break
                if (line.startsWith(":")) continue
                if (line.startsWith("event:")) {
                    event = line.substring(6).trim()
                    continue
                }
                if (line.startsWith("data:")) {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substring(5).trim())
                    continue
                }
                if (line.isEmpty()) {
                    if (event.isNotEmpty() && data.isNotEmpty()) {
                        try {
                            dispatch(event, JSONObject(data.toString()))
                        } catch (_: Exception) {
                        }
                    }
                    event = ""
                    data.setLength(0)
                }
            }
        } finally {
            try {
                stream.close()
            } catch (_: Exception) {
            }
            conn.disconnect()
        }
    }

    private fun dispatch(event: String, json: JSONObject) {
        mainHandler.post {
            when (event) {
                "alert" -> onAlert(json)
                "all_clear" -> onClear(json)
            }
        }
    }

    private fun onAlert(json: JSONObject) {
        AppEvents.currentAlert = json
        AlarmPlayer.start(this)
        notifyAlert(this, json)
    }

    private fun onClear(json: JSONObject) {
        AlarmPlayer.stop()
        AppEvents.currentAlert = null
        getSystemService(NotificationManager::class.java).cancel(NOTIF_ALERT)
        AppEvents.onClear?.invoke()
    }
}

fun createChannels(ctx: Context) {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CH_ALERTS) == null) {
        val ch = NotificationChannel(CH_ALERTS, "Emergency alerts", NotificationManager.IMPORTANCE_HIGH)
        ch.enableVibration(true)
        ch.vibrationPattern = longArrayOf(0, 500, 300, 500, 300, 500, 300, 500)
        ch.setSound(null, null)
        nm.createNotificationChannel(ch)
    }
    if (nm.getNotificationChannel(CH_MONITOR) == null) {
        val ch = NotificationChannel(CH_MONITOR, "Alert monitoring", NotificationManager.IMPORTANCE_MIN)
        ch.setSound(null, null)
        nm.createNotificationChannel(ch)
    }
}

fun monitorNotification(ctx: Context): Notification =
    Notification.Builder(ctx, CH_MONITOR)
        .setSmallIcon(R.drawable.ic_stat_alert)
        .setContentTitle("School Emergency is active")
        .setContentText("Emergency alerts arrive instantly, even in silent mode")
        .setOngoing(true)
        .build()

fun notifyAlert(ctx: Context, json: JSONObject) {
    val content = PendingIntent.getActivity(
        ctx,
        1,
        Intent(ctx, AlarmActivity::class.java).apply {
            putExtra("payload", json.toString())
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    val message = json.optString("message", "")
    val notif = Notification.Builder(ctx, CH_ALERTS)
        .setSmallIcon(R.drawable.ic_stat_alert)
        .setContentTitle(json.optString("title", "Emergency alert"))
        .setContentText(message.replace('\n', ' '))
        .setStyle(Notification.BigTextStyle().bigText(message))
        .setCategory(Notification.CATEGORY_ALARM)
        .setFullScreenIntent(content, true)
        .setContentIntent(content)
        .setAutoCancel(true)
        .build()

    ctx.getSystemService(NotificationManager::class.java).notify(NOTIF_ALERT, notif)
}
