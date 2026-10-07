package at.schoolemergency.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator

object AlarmPlayer {

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var app: Context? = null
    private var savedAlarmVolume = -1

    val isPlaying: Boolean
        @Synchronized get() = player != null

    @Synchronized
    fun start(ctx: Context) {
        app = ctx.applicationContext
        releaseSound()

        try {
            val am = ctx.applicationContext.getSystemService(AudioManager::class.java)
            val current = am.getStreamVolume(AudioManager.STREAM_ALARM)
            if (savedAlarmVolume < 0) savedAlarmVolume = current
            if (current == 0) {
                val target = (am.getStreamMaxVolume(AudioManager.STREAM_ALARM) * 7 / 10).coerceAtLeast(1)
                am.setStreamVolume(AudioManager.STREAM_ALARM, target, 0)
            }
        } catch (_: Exception) {
        }

        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            mp.setDataSource(
                ctx.applicationContext,
                Uri.parse("android.resource://" + ctx.packageName + "/" + R.raw.siren)
            )
            mp.isLooping = true
            mp.prepare()
            mp.start()
            player = mp
        } catch (_: Exception) {
        }

        try {
            val v = ctx.applicationContext.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            val timings = longArrayOf(0, 700, 250, 700, 250, 700, 250, 700)
            if (Build.VERSION.SDK_INT >= 26) {
                val amplitudes = intArrayOf(0, 255, 0, 255, 0, 255, 0, 255)
                v.vibrate(VibrationEffect.createWaveform(timings, amplitudes, 0))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(timings, 0)
            }
            vibrator = v
        } catch (_: Exception) {
        }
    }

    @Synchronized
    fun stop() {
        releaseSound()
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
        vibrator = null

        if (savedAlarmVolume >= 0) {
            try {
                app?.getSystemService(AudioManager::class.java)
                    ?.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0)
            } catch (_: Exception) {
            }
            savedAlarmVolume = -1
        }
    }

    private fun releaseSound() {
        try {
            player?.stop()
        } catch (_: Exception) {
        }
        try {
            player?.release()
        } catch (_: Exception) {
        }
        player = null
    }
}
