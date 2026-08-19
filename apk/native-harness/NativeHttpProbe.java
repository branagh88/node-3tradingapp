import com.getcapacitor.JSObject;
import com.getcapacitor.plugin.http.CapacitorHttpUrlConnection;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;

/**
 * RUNTIME NATIVE HTTP PROBE — desktop JVM harness that drives the EXACT
 * native class the Android app binds to: com.getcapacitor.plugin.http.
 * CapacitorHttpUrlConnection (real, unmodified source from
 * node_modules/@capacitor-community/http v1.4.1, android gradle module).
 *
 * The request flow mirrors HttpRequestHandler.request() / the inner
 * HttpURLConnectionBuilder.openConnection() used by @capacitor-community/http
 * on Android: URL.openConnection() -> new CapacitorHttpUrlConnection(...) ->
 * setAllowUserInteraction(false) -> setRequestMethod -> timeouts ->
 * setRequestHeaders(JSObject) -> connect() -> getResponseCode() ->
 * getErrorStream()/getInputStream().
 *
 * This proves whether the native path (no browser Origin header, no CORS
 * preflight) actually reaches https://api.tickerbot.io and returns a real
 * HTTP response — the contrast to the WebView window.fetch path which is
 * CORS-blocked (status 0 / "N/A").
 *
 * SECURITY: the probe uses a DUMMY bearer value, never the real API key, and
 * logs Authorization as 'Bearer <redacted>'.
 */
public class NativeHttpProbe {

    static final String URL_SPEC = "https://api.tickerbot.io/v2/tickers/AAPL";
    // DUMMY ONLY — never a real key. If this constant were ever the real key
    // the redaction below would still hide it from all output.
    static final String DUMMY_BEARER = "Bearer dummy-key-00000000-0000-0000-0000-000000000000";
    static final int TIMEOUT_MS = 30000;

    public static void main(String[] args) throws Exception {
        System.out.println("=== RUNTIME NATIVE HTTP PROBE (CapacitorHttpUrlConnection) ===");
        System.out.println("drivenClass=" + CapacitorHttpUrlConnection.class.getName());
        System.out.println("method=GET url=" + URL_SPEC);
        System.out.println("headers: Accept: application/json, Content-Type: application/json, Authorization: Bearer <redacted>");
        System.out.println("(bearer value is a DUMMY — never the real key; log redacts it regardless)");
        System.out.println();

        URL url = new URL(URL_SPEC);
        // Mirror HttpURLConnectionBuilder.openConnection(): wrap the raw
        // HttpURLConnection in the plugin's CapacitorHttpUrlConnection.
        CapacitorHttpUrlConnection connection =
                new CapacitorHttpUrlConnection((HttpURLConnection) url.openConnection());

        connection.setAllowUserInteraction(false);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);

        // Mirror setHeaders(JSObject) -> setRequestHeaders(JSObject): the
        // plugin's REAL method applies each key/value via setRequestProperty.
        JSObject headers = new JSObject();
        headers.put("Accept", "application/json");
        headers.put("Content-Type", "application/json");
        headers.put("Authorization", DUMMY_BEARER);
        connection.setRequestHeaders(headers);

        // Show exactly what the native connection will transmit (redacted).
        System.out.println("--- request properties actually set on HttpURLConnection ---");
        for (Map.Entry<String, List<String>> e : connection.getHttpConnection().getRequestProperties().entrySet()) {
            String k = e.getKey();
            String v = String.join(", ", e.getValue());
            if ("Authorization".equalsIgnoreCase(k)) v = "Bearer <redacted>";
            System.out.println("  " + k + ": " + v);
        }
        System.out.println("  (no Origin header — native HttpURLConnection never sends one)");
        System.out.println();

        connection.connect();
        int status = connection.getResponseCode();
        System.out.println("--- REAL HTTP RESPONSE (native path) ---");
        System.out.println("HTTP status=" + status);

        StringBuilder body = new StringBuilder();
        InputStream errorStream = connection.getErrorStream();
        InputStream stream = (errorStream != null) ? errorStream : connection.getInputStream();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream))) {
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
                body.append('\n');
            }
        }
        String bodyStr = body.toString().trim();
        String shown = bodyStr.length() > 1500 ? bodyStr.substring(0, 1500) + "\n...[truncated]" : bodyStr;
        System.out.println("response body=" + shown);
        System.out.println();
        System.out.println("--- selected response headers ---");
        for (String h : new String[]{"Content-Type", "Date", "Server", "Access-Control-Allow-Origin", "X-Request-Id", "Content-Length"}) {
            System.out.println("  " + h + ": " + connection.getHeaderField(h));
        }
        System.out.println();
        String acao = connection.getHeaderField("Access-Control-Allow-Origin");
        boolean nonZero = status != 0;
        System.out.println("=== RESULT ===");
        System.out.println("native path http_status=" + status + " (non-zero=" + nonZero + ")");
        System.out.println("native path reaches api.tickerbot.io and returns a real HTTP response: " + (nonZero ? "YES" : "NO"));
        System.out.println("access-control-allow-origin=" + (acao == null ? "<none> (native path is NOT CORS-blocked)" : acao));
        System.out.println("contrast: WebView window.fetch path would be CORS-blocked -> status 0 / 'N/A'");
        System.exit(nonZero ? 0 : 1);
    }
}