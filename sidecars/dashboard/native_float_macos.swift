import Cocoa
import WebKit

// Native macOS Menu Bar (`NSStatusItem`) & Right-Side Floating Window Host
// for Antigravity Context & Token Viewer.
// Communicates with `float_window.mjs` strictly over stdin/stdout JSON lines
// (zero TCP ports, zero proxy interference, zero Local Network prompts).

final class FloatBridge: NSObject, WKScriptMessageHandler {
  weak var controller: FloatWindowController?

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? String else { return }
    controller?.handleWebMessage(body)
  }
}

final class FloatWindowController: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var pinAccessoryButton: NSButton!
  var statusItem: NSStatusItem?
  let bridge = FloatBridge()

  var isPinned: Bool
  var isMenubarEnabled: Bool
  var isWindowVisible: Bool
  var menubarMode: String
  var statusTitle: String
  var statusTooltip: String = "上下文与 Token 看板\n\n左键显隐看板 · 右键切换模式与置顶"

  init(initialPinned: Bool, initialMenubar: Bool, initialVisible: Bool, initialMode: String) {
    self.isPinned = initialPinned
    self.isMenubarEnabled = initialMenubar
    self.isWindowVisible = initialVisible
    self.menubarMode = initialMode
    switch initialMode {
    case "speed":
      self.statusTitle = "⚡ --t/s"
    case "quota":
      self.statusTitle = "⏳ --%"
    default:
      self.statusTitle = "◈ --%"
    }
    super.init()
    bridge.controller = self
  }

  func emitJson(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    if let outData = line.data(using: .utf8) {
      FileHandle.standardOutput.write(outData)
    }
  }

  func setupMenus() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    let hideAppItem = NSMenuItem(title: "隐藏窗口", action: #selector(hideWindowAction), keyEquivalent: "h")
    hideAppItem.target = self
    appMenu.addItem(hideAppItem)
    appMenu.addItem(NSMenuItem.separator())
    let quitAppItem = NSMenuItem(title: "退出悬浮看板", action: #selector(quitAction), keyEquivalent: "q")
    quitAppItem.target = self
    appMenu.addItem(quitAppItem)
    appMenuItem.submenu = appMenu

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu

    let winMenuItem = NSMenuItem()
    mainMenu.addItem(winMenuItem)
    let winMenu = NSMenu(title: "窗口")
    let pinItem = NSMenuItem(title: "切换置顶状态", action: #selector(togglePinnedAction), keyEquivalent: "p")
    pinItem.keyEquivalentModifierMask = [.command, .shift]
    pinItem.target = self
    winMenu.addItem(pinItem)
    winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    winMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winMenuItem.submenu = winMenu

    NSApp.mainMenu = mainMenu
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    setupMenus()

    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let defaultWidth: CGFloat = 432
    let defaultHeight: CGFloat = min(880, max(540, screenFrame.height - 24))
    let defaultX: CGFloat = max(screenFrame.minX + 12, screenFrame.maxX - defaultWidth - 10)
    let defaultY: CGFloat = screenFrame.minY + (screenFrame.height - defaultHeight) / 2.0
    let initialRect = NSRect(x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight)

    window = NSWindow(
      contentRect: initialRect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.minSize = NSSize(width: 350, height: 420)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName("AntigravityContextViewerFloatV1")

    // Native right-side titlebar Pin / Unpin button
    let accVC = NSTitlebarAccessoryViewController()
    accVC.layoutAttribute = .right
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 82, height: 26))
    pinAccessoryButton = NSButton(frame: NSRect(x: 4, y: 2, width: 74, height: 22))
    pinAccessoryButton.bezelStyle = .inline
    pinAccessoryButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    pinAccessoryButton.target = self
    pinAccessoryButton.action = #selector(togglePinnedAction)
    container.addSubview(pinAccessoryButton)
    accVC.view = container
    window.addTitlebarAccessoryViewController(accVC)

    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: "cvBridge")
    webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
    webView.autoresizingMask = [.width, .height]
    window.contentView?.addSubview(webView)

    applyPinnedState(isPinned, notifyWeb: false)
    applyMenubarState(isMenubarEnabled, notifyWeb: false)

    if isWindowVisible {
      showWindow(notifyParent: false)
    }

    startStdinReader()
    emitJson([
      "type": "ready",
      "pinned": isPinned,
      "menubarEnabled": isMenubarEnabled,
      "menubarMode": menubarMode,
      "windowVisible": isWindowVisible
    ])
  }

  // MARK: - Menu Bar (`NSStatusItem`)

  func applyMenubarState(_ enabled: Bool, title: String? = nil, tooltip: String? = nil, notifyWeb: Bool = true) {
    isMenubarEnabled = enabled
    if let t = title, !t.isEmpty { statusTitle = t }
    if let tip = tooltip, !tip.isEmpty { statusTooltip = tip }

    if enabled {
      if statusItem == nil {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
          btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
          btn.target = self
          btn.action = #selector(statusBarClicked(_:))
          btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
      }
      statusItem?.button?.title = statusTitle
      statusItem?.button?.toolTip = statusTooltip
    } else if let item = statusItem {
      NSStatusBar.system.removeStatusItem(item)
      statusItem = nil
    }

    if notifyWeb {
      let js = "window.__cvOnHostMenubarChange && window.__cvOnHostMenubarChange(\(enabled ? "true" : "false"));"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  @objc func statusBarClicked(_ sender: NSStatusBarButton) {
    let ev = NSApp.currentEvent
    let isRightClick = (ev?.type == .rightMouseUp) || (ev?.modifierFlags.contains(.control) == true)
    if isRightClick {
      let menu = NSMenu()
      let toggleItem = NSMenuItem(
        title: window.isVisible ? "隐藏右侧看板小窗" : "弹出右侧看板小窗",
        action: #selector(toggleWindowAction),
        keyEquivalent: ""
      )
      toggleItem.target = self
      menu.addItem(toggleItem)

      let pinItem = NSMenuItem(
        title: "窗口置顶在屏幕最前",
        action: #selector(togglePinnedAction),
        keyEquivalent: ""
      )
      pinItem.state = isPinned ? .on : .off
      pinItem.target = self
      menu.addItem(pinItem)

      menu.addItem(NSMenuItem.separator())

      let modeHeader = NSMenuItem(title: "菜单栏显示内容（跟随当前会话）", action: nil, keyEquivalent: "")
      modeHeader.isEnabled = false
      menu.addItem(modeHeader)

      let modeCtxItem = NSMenuItem(
        title: "当前上下文使用占比",
        action: #selector(selectModeContextAction),
        keyEquivalent: ""
      )
      modeCtxItem.state = (menubarMode == "context") ? .on : .off
      modeCtxItem.target = self
      menu.addItem(modeCtxItem)

      let modeSpdItem = NSMenuItem(
        title: "最新生成速度与耗时 (均值/峰值)",
        action: #selector(selectModeSpeedAction),
        keyEquivalent: ""
      )
      modeSpdItem.state = (menubarMode == "speed") ? .on : .off
      modeSpdItem.target = self
      menu.addItem(modeSpdItem)

      let modeQtaItem = NSMenuItem(
        title: "5 小时 / Week 额度余量",
        action: #selector(selectModeQuotaAction),
        keyEquivalent: ""
      )
      modeQtaItem.state = (menubarMode == "quota") ? .on : .off
      modeQtaItem.target = self
      menu.addItem(modeQtaItem)

      menu.addItem(NSMenuItem.separator())

      let hideBarItem = NSMenuItem(
        title: "关闭顶部菜单栏图标",
        action: #selector(disableMenubarFromMenuAction),
        keyEquivalent: ""
      )
      hideBarItem.target = self
      menu.addItem(hideBarItem)

      let quitItem = NSMenuItem(
        title: "彻底退出悬浮看板",
        action: #selector(quitAction),
        keyEquivalent: ""
      )
      quitItem.target = self
      menu.addItem(quitItem)

      let popY: CGFloat = sender.isFlipped ? sender.bounds.maxY + 4 : -4
      menu.popUp(positioning: nil, at: NSPoint(x: 0, y: popY), in: sender)
    } else {
      toggleWindowAction()
    }
  }

  func selectMenubarModeFromMenu(_ mode: String) {
    menubarMode = mode
    let js = "window.__cvOnHostMenubarModeChange && window.__cvOnHostMenubarModeChange('\(mode)');"
    webView?.evaluateJavaScript(js, completionHandler: nil)
    emitJson(["type": "menubarModeChanged", "mode": mode])
  }

  @objc func selectModeContextAction() {
    selectMenubarModeFromMenu("context")
  }

  @objc func selectModeSpeedAction() {
    selectMenubarModeFromMenu("speed")
  }

  @objc func selectModeQuotaAction() {
    selectMenubarModeFromMenu("quota")
  }

  @objc func disableMenubarFromMenuAction() {
    applyMenubarState(false, notifyWeb: true)
    emitJson(["type": "userDisabledMenubar", "windowVisible": window.isVisible])
    if !window.isVisible {
      NSApp.terminate(nil)
    }
  }

  @objc func quitAction() {
    emitJson(["type": "closed"])
    NSApp.terminate(nil)
  }

  // MARK: - Window Show / Hide / Pin

  func showWindow(notifyParent: Bool = true) {
    if window.isMiniaturized { window.deminiaturize(nil) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    isWindowVisible = true
    webView?.evaluateJavaScript("window.__cvOnHostVisibility && window.__cvOnHostVisibility(true);", completionHandler: nil)
    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": true])
    }
  }

  func hideWindow(notifyParent: Bool = true) {
    window.orderOut(nil)
    isWindowVisible = false
    webView?.evaluateJavaScript("window.__cvOnHostVisibility && window.__cvOnHostVisibility(false);", completionHandler: nil)
    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": false])
    }
  }

  @objc func hideWindowAction() {
    if isMenubarEnabled {
      hideWindow(notifyParent: true)
    } else {
      emitJson(["type": "closed"])
      NSApp.terminate(nil)
    }
  }

  @objc func toggleWindowAction() {
    if !window.isVisible || (!isPinned && !NSApp.isActive) {
      showWindow(notifyParent: true)
    } else {
      hideWindow(notifyParent: true)
    }
  }

  @objc func togglePinnedAction() {
    applyPinnedState(!isPinned, notifyWeb: true)
  }

  func applyPinnedState(_ pinned: Bool, notifyWeb: Bool) {
    isPinned = pinned
    if pinned {
      window.level = .floating
      window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      window.title = "上下文看板 · 已钉在右侧"
      pinAccessoryButton?.title = "📌 已置顶"
    } else {
      window.level = .normal
      window.collectionBehavior = []
      window.title = "上下文看板"
      pinAccessoryButton?.title = "📍 置顶"
    }
    emitJson(["type": "pinChanged", "pinned": pinned])
    if notifyWeb {
      let js = "window.__cvOnHostPinChange && window.__cvOnHostPinChange(\(pinned ? "true" : "false"));"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if isMenubarEnabled {
      hideWindow(notifyParent: true)
      return false
    } else {
      emitJson(["type": "closed"])
      NSApp.terminate(nil)
      return true
    }
  }

  // MARK: - Web & Parent IPC

  func handleWebMessage(_ raw: String) {
    guard let data = raw.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let kind = obj["kind"] as? String else { return }

    if kind == "togglePin" {
      let next = (obj["pinned"] as? Bool) ?? (!isPinned)
      applyPinnedState(next, notifyWeb: true)
    } else if kind == "closeWindow" {
      hideWindowAction()
    } else if kind == "rpc" {
      emitJson([
        "type": "rpcRequest",
        "id": obj["id"] ?? 0,
        "path": obj["path"] ?? "",
        "method": obj["method"] ?? "GET",
        "body": obj["body"] ?? NSNull()
      ])
    }
  }

  func startStdinReader() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      let stdinHandle = FileHandle.standardInput
      while true {
        let chunk = stdinHandle.availableData
        if chunk.isEmpty {
          DispatchQueue.main.async { NSApp.terminate(nil) }
          break
        }
        buffer.append(chunk)
        while let nlRange = buffer.range(of: Data([0x0a])) {
          let lineData = buffer.subdata(in: 0..<nlRange.lowerBound)
          buffer.removeSubrange(0..<nlRange.upperBound)
          if lineData.isEmpty { continue }
          if let msg = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any] {
            DispatchQueue.main.async {
              self?.handleParentCommand(msg)
            }
          }
        }
      }
    }
  }

  func handleParentCommand(_ msg: [String: Any]) {
    guard let type = msg["type"] as? String else { return }
    switch type {
    case "loadHtml":
      if let html = msg["html"] as? String {
        webView.loadHTMLString(html, baseURL: nil)
      }
    case "rpcReply":
      guard let id = msg["id"],
            let payloadData = try? JSONSerialization.data(withJSONObject: msg["payload"] ?? [:], options: []),
            let payloadJson = String(data: payloadData, encoding: .utf8) else { return }
      let ok = (msg["ok"] as? Bool) ?? true
      let status = (msg["status"] as? Int) ?? (ok ? 200 : 500)
      let js = "window.__cvResolveRpc && window.__cvResolveRpc(\(id), \(status), \(payloadJson));"
      webView.evaluateJavaScript(js, completionHandler: nil)
    case "setPinned":
      if let p = msg["pinned"] as? Bool {
        applyPinnedState(p, notifyWeb: true)
      }
    case "setMenubar":
      let en = (msg["enabled"] as? Bool) ?? isMenubarEnabled
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
      }
      applyMenubarState(en, title: msg["title"] as? String, tooltip: msg["tooltip"] as? String, notifyWeb: true)
      if !en && !window.isVisible {
        emitJson(["type": "closed"])
        NSApp.terminate(nil)
      }
    case "setMenubarMode":
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
        let js = "window.__cvOnHostMenubarModeChange && window.__cvOnHostMenubarModeChange('\(m)');"
        webView?.evaluateJavaScript(js, completionHandler: nil)
      }
      if let t = msg["title"] as? String, !t.isEmpty {
        statusTitle = t
        statusItem?.button?.title = t
      }
      if let tip = msg["tooltip"] as? String, !tip.isEmpty {
        statusTooltip = tip
        statusItem?.button?.toolTip = tip
      }
    case "updateStatusItem":
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
      }
      if let t = msg["title"] as? String, !t.isEmpty {
        statusTitle = t
        statusItem?.button?.title = t
      }
      if let tip = msg["tooltip"] as? String, !tip.isEmpty {
        statusTooltip = tip
        statusItem?.button?.toolTip = tip
      }
    case "showWindow", "focus":
      showWindow(notifyParent: true)
    case "hideWindow":
      hideWindowAction()
    case "toggleWindow":
      toggleWindowAction()
    case "quit":
      NSApp.terminate(nil)
    default:
      break
    }
  }
}

let args = CommandLine.arguments
let initialPinned = !args.contains("--unpinned")
let initialMenubar = !args.contains("--no-menubar")
let initialVisible = !args.contains("--hidden-window")
var initialMode = "context"
if let idx = args.firstIndex(of: "--mode"), idx + 1 < args.count {
  let candidate = args[idx + 1]
  if candidate == "context" || candidate == "speed" || candidate == "quota" {
    initialMode = candidate
  }
}

let app = NSApplication.shared
// `.accessory` keeps the user's Dock uncluttered while rendering StatusItem + floating window
app.setActivationPolicy(.accessory)
let delegate = FloatWindowController(
  initialPinned: initialPinned,
  initialMenubar: initialMenubar,
  initialVisible: initialVisible,
  initialMode: initialMode
)
app.delegate = delegate
app.run()
