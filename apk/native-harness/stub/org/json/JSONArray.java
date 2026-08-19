package org.json;

/**
 * Real, minimal org.json.JSONArray for the desktop harness (android.jar ships
 * stub classes). Only the surface the real plugin sources touch is provided.
 */
public class JSONArray {

    private final java.util.List<Object> list = new java.util.ArrayList<>();

    public JSONArray() {}

    public JSONArray(String json) throws JSONException {
        // Permissive stand-in: keep the raw payload instead of parsing.
        if (json != null) list.add(json);
    }

    public JSONArray put(Object value) {
        list.add(value);
        return this;
    }

    public int length() {
        return list.size();
    }

    public Object get(int index) throws JSONException {
        if (index < 0 || index >= list.size()) throw new JSONException("Index " + index + " out of range");
        return list.get(index);
    }

    public String getString(int index) throws JSONException {
        return String.valueOf(get(index));
    }

    @Override
    public String toString() {
        return list.toString();
    }
}