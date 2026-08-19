package com.arkpulse.arkpulseandroidfs

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.DialogInterface
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// 安卓原生桥接：MediaStore 落盘 / SAF 持久目录 / 完成确认弹窗 / 亮屏保活。
// Kotlin 方法名用 camelCase：Tauri 运行时把 snake_case 命令名转为 camelCase 后按 method.name 查找。
// 前端 invoke('plugin:arkpulse-android-fs|mediastore_insert') ↔ 此处 mediastoreInsert。
@TauriPlugin
class ArkPulseAndroidFsPlugin(private val activity: Activity) : Plugin(activity) {

    // L1：向 MediaStore.Downloads 插入文件，默认落到 Download/ArkPulse。零权限零弹框。
    // 支持可选 relativePath（子目录，如 "Download/ArkPulse/log"）与 bytes（base64，直接写入内容）。
    @Command
    fun mediastoreInsert(invoke: Invoke) {
        val args = invoke.getArgs()
        val name = args.getString("name")
        val relativePath = args.getString("relative_path", "Download/ArkPulse")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            invoke.reject("需要 Android 10 及以上")
            return
        }
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.RELATIVE_PATH, relativePath)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            invoke.reject("MediaStore 插入失败：存储不可用或被拒绝")
            return
        }
        val b64 = args.getString("bytes")
        if (!b64.isNullOrEmpty()) {
            try {
                val data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                resolver.openOutputStream(uri)?.use { it.write(data) }
            } catch (e: Exception) {
                invoke.reject("写入文件失败：${e.message}")
                return
            }
        }
        val ret = JSObject()
        ret.put("uri", uri.toString())
        invoke.resolve(ret)
    }

    // L3：对 SAF 树 URI 取得持久化授权（重启后仍可写），权限存入系统。
    @Command
    fun safTakePermission(invoke: Invoke) {
        val treeUri = Uri.parse(invoke.getArgs().getString("tree_uri"))
        try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            activity.contentResolver.takePersistableUriPermission(treeUri, flags)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("无法持久化 SAF 授权：${e.message}")
        }
    }

    // L3：在已授权树目录下创建子文档，返回可直接流式写入的 content URI（无需再次弹框）。
    @Command
    fun safCreateChild(invoke: Invoke) {
        val treeUri = Uri.parse(invoke.getArgs().getString("tree_uri"))
        val name = invoke.getArgs().getString("name")
        try {
            val docUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            )
            val childUri = DocumentsContract.createDocument(
                activity.contentResolver,
                docUri,
                "application/octet-stream",
                name
            )
            if (childUri == null) {
                invoke.reject("SAF 创建子文件失败")
                return
            }
            val ret = JSObject()
            ret.put("uri", childUri.toString())
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject("SAF 创建子文件失败：${e.message}")
        }
    }

    // 下载完成确认弹窗：原生 AlertDialog + 单「确定」按钮，点确定才 resolve（不自动消失）。
    @Command
    fun showSaveDialog(invoke: Invoke) {
        val title = invoke.getArgs().getString("title")
        val message = invoke.getArgs().getString("message")
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton("确定") { _: DialogInterface?, _: Int -> invoke.resolve() }
                .show()
        }
    }

    // 下载期间亮屏保活：对当前 Activity 窗口加/清 FLAG_KEEP_SCREEN_ON（不阻止手动锁屏）。
    @Command
    fun setKeepScreenOn(invoke: Invoke) {
        val enabled = invoke.getArgs().getBoolean("enabled")
        activity.runOnUiThread {
            val window = activity.window
            if (enabled) {
                window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        invoke.resolve()
    }
}
