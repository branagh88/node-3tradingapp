package org.json;

/** Real, minimal org.json.JSONException for the desktop harness (android.jar ships stubs). */
public class JSONException extends Exception {
    public JSONException(String message) {
        super(message);
    }

    public JSONException(String message, Throwable cause) {
        super(message, cause);
    }
}