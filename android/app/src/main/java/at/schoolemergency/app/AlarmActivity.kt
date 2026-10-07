package at.schoolemergency.app

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AlarmActivity : Activity() {

    private var alertId = 0L
    private var cleared = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_alarm)

        val json = parsePayload()
        bind(json)

        if (json != null && !AlarmPlayer.isPlaying) {
            AlarmPlayer.start(this)
        }

        findViewById<Button>(R.id.btnSafe).setOnClickListener { sendSafe() }
        findViewById<Button>(R.id.btnSoundOff).setOnClickListener {
            AlarmPlayer.stop()
        }
    }

    private fun parsePayload(): JSONObject? {
        val fromIntent = intent?.getStringExtra("payload")
        val candidates = listOfNotNull(fromIntent, AppEvents.currentAlert?.toString())
        for (c in candidates) {
            try {
                return JSONObject(c)
            } catch (_: Exception) {
            }
        }
        return null
    }

    private fun bind(json: JSONObject?) {
        if (json == null) {
            findViewById<TextView>(R.id.alarmType).text = "🚨 SCHOOL EMERGENCY"
            findViewById<TextView>(R.id.alarmBody).text =
                "An emergency has been reported. Follow staff instructions."
            return
        }
        alertId = json.optLong("alertId", 0)
        val type = json.optString("type", "")
        val icon = when (type) {
            "fire" -> "🔥"
            "evacuation" -> "🏃"
            "lockdown" -> "🔒"
            "medical" -> "🚑"
            "danger" -> "⚠️"
            else -> "🚨"
        }
        val title = json.optString("title", "EMERGENCY")
        findViewById<TextView>(R.id.alarmType).text = "$icon $title"
        findViewById<TextView>(R.id.alarmBody).text = json.optString("message", "")
        val now = SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date())
        val school = getSharedPreferences("se", MODE_PRIVATE).getString("school", "") ?: ""
        findViewById<TextView>(R.id.alarmTime).text = "$now  •  $school"
    }

    private fun sendSafe() {
        val prefs = getSharedPreferences("se", MODE_PRIVATE)
        val base = prefs.getString("base", "") ?: ""
        val token = prefs.getString("token", "") ?: ""
        val id = alertId
        val btn = findViewById<Button>(R.id.btnSafe)
        btn.isEnabled = false
        Thread {
            if (id > 0 && base.isNotEmpty() && token.isNotEmpty()) {
                try {
                    Api.safe(base, token, id)
                } catch (_: Exception) {
                }
            }
            runOnUiThread {
                AlarmPlayer.stop()
                Toast.makeText(this, "Marked SAFE — the school has been notified", Toast.LENGTH_LONG).show()
                finish()
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        AppEvents.onClear = {
            if (!cleared) {
                cleared = true
                AlarmPlayer.stop()
                Toast.makeText(this, "ENTWARNUNG / ALL CLEAR", Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    override fun onPause() {
        AppEvents.onClear = null
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        AlarmPlayer.stop()
        super.onBackPressed()
    }

    override fun onDestroy() {
        AppEvents.onClear = null
        super.onDestroy()
    }
}
