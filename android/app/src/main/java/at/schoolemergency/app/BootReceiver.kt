package at.schoolemergency.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        val prefs = context.getSharedPreferences("se", Context.MODE_PRIVATE)
        val monitoring = prefs.getBoolean("monitoring", false)
        val token = prefs.getString("token", "") ?: ""
        if (monitoring && token.isNotEmpty()) {
            try {
                AlertService.start(context)
            } catch (_: Exception) {
            }
        }
    }
}
