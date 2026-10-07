package at.schoolemergency.app

import org.json.JSONObject

object AppEvents {
    @Volatile
    var currentAlert: JSONObject? = null

    @Volatile
    var onClear: (() -> Unit)? = null
}
