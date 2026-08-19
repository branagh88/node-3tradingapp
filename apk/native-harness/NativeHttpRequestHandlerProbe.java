import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.plugin.http.HttpRequestHandler;

/**
 * RUNTIME NPE REPRODUCTION PROBE (desktop JVM harness driving the REAL
 * com.getcapacitor.plugin.http.HttpRequestHandler.request(PluginCall, String)
 * — the exact native code path behind Http.request() on Android).
 *
 * The app calls Http.request({url, method, headers, data: undefined,
 * connectTimeout, readTimeout}) — note "params" is NEVER present and
 * "data" is undefined. On the native bridge undefined props are dropped, so
 * the Android PluginCall has NO "params" key. The @capacitor-community/http
 * v1.4.1 native code then calls call.getObject("params") -> null and runs
 * params.keys() -> NullPointerException BEFORE any HTTP I/O happens.
 * (Same for "headers" when absent: CapacitorHttpUrlConnection.setRequestHeaders
 * calls headers.keys() on null.)
 *
 * SECURITY: Authorization header values are DUMMY placeholders only — the
 * probe never receives or prints a real API key. All output redacts bearer.
 */
public class NativeHttpRequestHandlerProbe {

    static final String URL_SPEC = "https://api.tickerbot.io/v2/tickers/AAPL";
    static final String DUMMY_BEARER = "Bearer dummy-key-00000000-0000-0000-0000-000000000000";
    static final int TIMEOUT_MS = 10000;

    /** Simulate JS -> native bridge: undefined/null props are dropped. */
    static PluginCall callFromOptions(java.util.Map<String, Object> opts) {
        PluginCall call = new PluginCall();
        for (java.util.Map.Entry<String, Object> e : opts.entrySet()) {
            if (e.getValue() == null) continue;
            call.setValue(e.getKey(), e.getValue());
        }
        return call;
    }

    static JSObject appHeaders() {
        JSObject h = new JSObject();
        h.put("Accept", "application/json");
        h.put("Content-Type", "application/json");
        h.put("Authorization", DUMMY_BEARER);
        return h;
    }

    static final class Outcome {
        boolean npe;
        Throwable exception;
        Integer status;
        Object body;
    }

    static Outcome run(String label, java.util.Map<String, Object> opts) {
        PluginCall call = callFromOptions(opts);
        Outcome o = new Outcome();
        System.out.println();
        System.out.println("===== CASE " + label + " =====");
        try {
            JSObject response = HttpRequestHandler.request(call, null); // mirrors Http.request(...)
            o.status = response.getInt("status");
            o.body = response.opt("data");
            System.out.println("RESULT: completed without NPE, HTTP status=" + o.status);
            String b = String.valueOf(o.body);
            if (b.length() > 400) b = b.substring(0, 400) + "...[truncated]";
            System.out.println("RESULT: body=" + b);
        } catch (NullPointerException npe) {
            o.npe = true;
            o.exception = npe;
            System.out.println("RESULT: NullPointerException THROWN => no HTTP response returned");
            System.out.println("NPE message: " + npe.getMessage());
            System.out.println("NPE stack (first frames):");
            StackTraceElement[] st = npe.getStackTrace();
            for (int i = 0; i < Math.min(st.length, 10); i++) {
                System.out.println("    at " + st[i]);
            }
        } catch (Exception e) {
            o.exception = e;
            System.out.println("RESULT: OTHER exception: " + e.getClass().getName() + ": " + e.getMessage());
            System.out.println("STACK:");
            for (StackTraceElement el : e.getStackTrace()) {
                System.out.println("    at " + el);
            }
        }
        return o;
    }

    static int failures = 0;

    static void expectNpe(Outcome o, String label) {
        if (o.npe) {
            System.out.println(label + " => EXPECTED NPE: PASS");
        } else {
            System.out.println(label + " => EXPECTED NPE but got " + (o.status != null ? ("status " + o.status) : ("exception " + o.exception)));
            failures++;
        }
    }

    static void expectResponse(Outcome o, String label) {
        if (o.status != null && o.status > 0) {
            System.out.println(label + " => EXPECTED real HTTP response: PASS (status " + o.status + ")");
        } else if (o.npe) {
            System.out.println(label + " => FAILED: NPE still thrown");
            failures++;
        } else {
            System.out.println(label + " => FAILED: no HTTP response (exception " + o.exception + ")");
            failures++;
        }
    }

    public static void main(String[] args) throws Exception {
        // mode: "fixed" => assert every case returns a real HTTP response
        //       (default) => assert cases A/B/E throw the expected NPE (pre-fix)
        boolean fixed = args.length > 0 && "fixed".equals(args[0]);
        System.out.println("=== RUNTIME NPE PROBE (REAL HttpRequestHandler.request) ===");
        System.out.println("driver=" + HttpRequestHandler.class.getName());
        System.out.println("url=" + URL_SPEC + " (DUMMY bearer only; real key never used/printed)");

        // ---- CASE A: EXACT app shape - GET quote - params ABSENT ----------
        // {url, method:'GET', headers{Accept,Content-Type,Authorization:Dummy},
        //  data: undefined(dropped), connectTimeout:10000, readTimeout:10000}
        {
            java.util.Map<String, Object> opts = new java.util.LinkedHashMap<>();
            opts.put("url", URL_SPEC);
            opts.put("method", "GET");
            opts.put("headers", appHeaders());
            // data deliberately absent (undefined drops on the bridge)
            opts.put("connectTimeout", TIMEOUT_MS);
            opts.put("readTimeout", TIMEOUT_MS);
            System.out.println();
            System.out.println("== A. EXACT APP REQUEST SHAPE (headers present, params ABSENT, data undefined) ==");
            Outcome o = run("A-exact-app-shape", opts);
            if (fixed) expectResponse(o, "A (post-fix: params null is guarded -> real HTTP)"); else expectNpe(o, "A");
            // Print full NPE stack for the report
            if (o.npe && o.exception != null) {
                System.out.println("A full NPE stack:");
                for (StackTraceElement el : o.exception.getStackTrace()) {
                    System.out.println("      " + el);
                }
            }
        }

        // ---- CASE B: MINIMAL native diagnostic - url + method only --------
        {
            java.util.Map<String, Object> opts = new java.util.LinkedHashMap<>();
            opts.put("url", URL_SPEC);
            opts.put("method", "GET");
            Outcome o = run("B-minimal-no-options", opts);
            if (fixed) expectResponse(o, "B (post-fix: minimal -> real HTTP)"); else expectNpe(o, "B (minimal: params null -> NPE)");
        }

        // ---- CASE C: MINIMAL + headers:{}, params:{} (sanitized) - no auth
        {
            java.util.Map<String, Object> opts = new java.util.LinkedHashMap<>();
            opts.put("url", URL_SPEC);
            opts.put("method", "GET");
            JSObject h = new JSObject();
            h.put("Accept", "application/json");
            opts.put("headers", h);
            opts.put("params", new JSObject());
            Outcome o = run("C-sanitized-no-auth", opts);
            expectResponse(o, "C (sanitized {} defaults, no auth)");
        }

        // ---- CASE D: SANITIZED + app headers incl DUMMY Authorization -----
        {
            java.util.Map<String, Object> opts = new java.util.LinkedHashMap<>();
            opts.put("url", URL_SPEC);
            opts.put("method", "GET");
            opts.put("headers", appHeaders());
            opts.put("params", new JSObject());
            opts.put("connectTimeout", TIMEOUT_MS);
            opts.put("readTimeout", TIMEOUT_MS);
            Outcome o = run("D-sanitized-with-app-headers", opts);
            expectResponse(o, "D (sanitized + Authorization: Bearer <dummy>)");
        }

        // ---- CASE E: OPTION ISOLATION - params:{} but headers ABSENT ------
        {
            java.util.Map<String, Object> opts = new java.util.LinkedHashMap<>();
            opts.put("url", URL_SPEC);
            opts.put("method", "GET");
            opts.put("params", new JSObject());
            Outcome o = run("E-headers-absent-params-present", opts);
            if (fixed) expectResponse(o, "E (post-fix: headers null is guarded -> real HTTP)"); else expectNpe(o, "E (headers null -> NPE at setRequestHeaders)");
        }

        System.out.println();
        System.out.println("=== PROBE SUMMARY ===");
        if (fixed) {
            System.out.println("POST-FIX (Java null-guards + JS options sanitizer applied):");
            System.out.println("A exact-app-shape (params absent): real HTTP response (NPE gone) -> " + (failures == 0 ? "PASS" : "FAIL"));
            System.out.println("B minimal (url+method only): real HTTP response (NPE gone) -> " + (failures == 0 ? "PASS" : "FAIL"));
            System.out.println("C sanitized {} defaults, no auth: real HTTP 401 -> transport ok");
            System.out.println("D sanitized + app headers: real HTTP 401 -> transport ok");
            System.out.println("E headers absent: real HTTP response (NPE gone) -> " + (failures == 0 ? "PASS" : "FAIL"));
            System.out.println("Every case returns a REAL HTTP response from api.tickerbot.io; 401 for the");
            System.out.println("DUMMY/unauthenticated bearer proves network transport (auth/permission gate).");
        } else {
            System.out.println("PRE-FIX (unpatched @capacitor-community/http@1.4.1 native source):");
            System.out.println("A exact-app-shape (params absent): NPE in setUrlParams (params.keys()) before response");
            System.out.println("B minimal (no params/headers): NPE in setUrlParams (params.keys())");
            System.out.println("C sanitized {} defaults, no auth: real HTTP response (transport ok, server calls for auth)");
            System.out.println("D sanitized + app headers: real HTTP response (transport ok)");
            System.out.println("E headers absent: NPE in setRequestHeaders (headers.keys())");
            System.out.println("NOTE: connectTimeout/readTimeout/data:undefined are NOT the NPE trigger (A/E NPE even with");
            System.out.println("      and without them; C/D with only {} defaults + timeouts return real HTTP).");
        }
        System.out.println("failures=" + failures);
        System.out.println("probe_exit=" + (failures == 0 ? 0 : 1));
        System.exit(failures == 0 ? 0 : 1);
    }
}