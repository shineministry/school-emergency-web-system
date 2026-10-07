package at.schoolemergency.app

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object Api {

    fun request(base: String, path: String, method: String, token: String?, body: String?): Pair<Int, String> {
        val conn = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 8000
            conn.readTimeout = 20000
            conn.setRequestProperty("Content-Type", "application/json")
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                conn.doOutput = true
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            val text = stream?.let { BufferedReader(InputStreamReader(it, Charsets.UTF_8)).readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    fun login(base: String, email: String, password: String): JSONObject {
        val body = JSONObject().put("email", email).put("password", password).toString()
        val (code, text) = request(base, "/api/auth/login", "POST", null, body)
        if (code != 200) {
            val err = try {
                JSONObject(text).optString("error")
            } catch (_: Exception) {
                ""
            }
            throw Exception(if (err.isNotEmpty()) err else "Login failed (HTTP $code)")
        }
        return JSONObject(text)
    }

    fun safe(base: String, token: String, alertId: Long): Pair<Int, String> =
        request(base, "/api/alerts/$alertId/safe", "POST", token, "{}")

    fun ack(base: String, token: String, alertId: Long): Pair<Int, String> =
        request(base, "/api/alerts/$alertId/ack", "POST", token, "{}")
}
