package at.schoolemergency.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var inputServer: EditText
    private lateinit var inputEmail: EditText
    private lateinit var inputPassword: EditText
    private lateinit var btnLogin: Button
    private lateinit var mainError: TextView
    private lateinit var statusCard: LinearLayout
    private lateinit var statusName: TextView
    private lateinit var statusRole: TextView
    private lateinit var statusSchool: TextView
    private lateinit var statusMonitor: TextView
    private lateinit var btnMonitor: Button
    private lateinit var btnLogout: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        inputServer = findViewById(R.id.inputServer)
        inputEmail = findViewById(R.id.inputEmail)
        inputPassword = findViewById(R.id.inputPassword)
        btnLogin = findViewById(R.id.btnLogin)
        mainError = findViewById(R.id.mainError)
        statusCard = findViewById(R.id.statusCard)
        statusName = findViewById(R.id.statusName)
        statusRole = findViewById(R.id.statusRole)
        statusSchool = findViewById(R.id.statusSchool)
        statusMonitor = findViewById(R.id.statusMonitor)
        btnMonitor = findViewById(R.id.btnMonitor)
        btnLogout = findViewById(R.id.btnLogout)

        val prefs = getSharedPreferences("se", MODE_PRIVATE)
        inputServer.setText(prefs.getString("base", "http://10.0.25.99:5000"))
        inputEmail.setText(prefs.getString("email", ""))

        if (!prefs.getString("token", "").isNullOrEmpty()) {
            showStatus()
        }

        btnLogin.setOnClickListener { doLogin() }
        btnMonitor.setOnClickListener { toggleMonitoring() }
        btnLogout.setOnClickListener { doLogout() }
    }

    private fun showError(msg: String?) {
        if (msg.isNullOrEmpty()) {
            mainError.visibility = View.GONE
        } else {
            mainError.text = msg
            mainError.visibility = View.VISIBLE
        }
    }

    private fun doLogin() {
        val base = inputServer.text.toString().trim()
        val email = inputEmail.text.toString().trim()
        val password = inputPassword.text.toString()
        if (base.isEmpty() || email.isEmpty() || password.isEmpty()) {
            showError("Server, email and password are required")
            return
        }
        showError(null)
        btnLogin.isEnabled = false
        btnLogin.text = "SIGNING IN…"

        Thread {
            try {
                val result = Api.login(base, email, password)
                val user = result.getJSONObject("user")
                getSharedPreferences("se", MODE_PRIVATE).edit()
                    .putString("base", base)
                    .putString("email", email)
                    .putString("token", result.getString("token"))
                    .putString("name", user.optString("name"))
                    .putString("role", user.optString("role"))
                    .putString("school", user.optString("school"))
                    .putBoolean("monitoring", false)
                    .apply()
                runOnUiThread {
                    btnLogin.isEnabled = true
                    btnLogin.text = getString(R.string.login)
                    requestAlertPermissions()
                    showStatus()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    btnLogin.isEnabled = true
                    btnLogin.text = getString(R.string.login)
                    showError(e.message)
                }
            }
        }.start()
    }

    private fun showStatus() {
        val prefs = getSharedPreferences("se", MODE_PRIVATE)
        statusCard.visibility = View.VISIBLE
        statusName.text = prefs.getString("name", "")
        statusRole.text = "Role: " + prefs.getString("role", "")
        statusSchool.text = prefs.getString("school", "")
        val monitoring = prefs.getBoolean("monitoring", false)
        btnMonitor.text = if (monitoring) "STOP MONITORING" else "START MONITORING"
        btnMonitor.backgroundTintList =
            android.content.res.ColorStateList.valueOf(getColor(if (monitoring) R.color.red else R.color.green))
        statusMonitor.text = if (monitoring) {
            "● Monitoring active — full-screen alerts + silent-mode alarm enabled"
        } else {
            "○ Monitoring stopped — you will NOT receive alerts"
        }
    }

    private fun toggleMonitoring() {
        val prefs = getSharedPreferences("se", MODE_PRIVATE)
        val monitoring = prefs.getBoolean("monitoring", false)
        if (monitoring) {
            AlertService.stop(this)
            prefs.edit().putBoolean("monitoring", false).apply()
        } else {
            requestAlertPermissions()
            optimizeBattery()
            AlertService.start(this)
            prefs.edit().putBoolean("monitoring", true).apply()
            Toast.makeText(this, "Monitoring started", Toast.LENGTH_SHORT).show()
        }
        showStatus()
    }

    private fun doLogout() {
        AlertService.stop(this)
        AlarmPlayer.stop()
        getSharedPreferences("se", MODE_PRIVATE).edit()
            .remove("token")
            .remove("name")
            .remove("role")
            .remove("school")
            .putBoolean("monitoring", false)
            .apply()
        statusCard.visibility = View.GONE
        inputPassword.text = null
        Toast.makeText(this, "Logged out", Toast.LENGTH_SHORT).show()
    }

    private fun requestAlertPermissions() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    private fun optimizeBattery() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                startActivity(
                    Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        } catch (_: Exception) {
        }
    }
}
