import AppKit
import SwiftUI
import WebKit

/// Renders an email's HTML with scripts disabled, sized to its content so the thread scrolls as one page.
struct HTMLMessageView: View {
    let html: String
    @State private var height: CGFloat = 80

    var body: some View {
        HTMLWebView(html: html, height: $height)
            .frame(height: height)
    }
}

private struct HTMLWebView: NSViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $height)
    }

    func makeNSView(context: Context) -> ContentSizedWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()
        let webView = ContentSizedWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.onWidthChange = { [weak coordinator = context.coordinator] in coordinator?.measure($0) }
        return webView
    }

    func updateNSView(_ webView: ContentSizedWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        webView.loadHTMLString(Self.document(wrapping: html), baseURL: nil)
    }

    static func document(wrapping body: String) -> String {
        """
        <!doctype html>
        <html><head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
        <style>
          :root { color-scheme: light; }
          html, body { margin: 0; padding: 0; background: #fff; }
          body { font: 14px -apple-system, sans-serif; color: #1d1d1f; overflow-wrap: anywhere; }
          #openmail-root { display: flow-root; }
          img { max-width: 100%; height: auto; }
          pre { white-space: pre-wrap; }
        </style>
        </head><body><div id="openmail-root">\(body)</div></body></html>
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?
        private let height: Binding<CGFloat>

        init(height: Binding<CGFloat>) {
            self.height = height
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measure(webView)
        }

        func measure(_ webView: WKWebView) {
            let script = "document.getElementById('openmail-root').getBoundingClientRect().height"
            webView.evaluateJavaScript(script) { [height] result, _ in
                guard let value = result as? Double, value > 0 else { return }
                MainActor.assumeIsolated { height.wrappedValue = ceil(value) }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

final class ContentSizedWebView: WKWebView {
    var onWidthChange: ((WKWebView) -> Void)?

    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = newSize.width != frame.width
        super.setFrameSize(newSize)
        if widthChanged, !isLoading { onWidthChange?(self) }
    }
}
