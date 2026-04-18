public async void SendAnswer(int answerIndex, float responseTime)
{
    if (!IsConnected)
    {
        Debug.LogWarning("SendAnswer bloqué : socket non connecté [" + gameObject.name + "]");
        return;
    }

    if (string.IsNullOrEmpty(CurrentRoomCode) || string.IsNullOrEmpty(PlayerId))
    {
        Debug.LogWarning(
            "SendAnswer bloqué : client non associé à une room [" + gameObject.name + "]"
            + " | room=" + CurrentRoomCode
            + " | playerId=" + PlayerId
        );
        return;
    }

    if (answerIndex < 0 || answerIndex > 3)
    {
        Debug.LogWarning("SendAnswer bloqué : answerIndex invalide = " + answerIndex);
        return;
    }

    float maxTimeSeconds = CurrentTimeLimitSeconds > 0f ? CurrentTimeLimitSeconds : 5f;
    float safeTimeSeconds = Mathf.Clamp(responseTime, 0f, maxTimeSeconds);
    int safeTimeMs = Mathf.RoundToInt(safeTimeSeconds * 1000f);

    string json =
        "{"
        + "\"type\":\"ANSWER\","
        + "\"answer\":" + answerIndex + ","
        + "\"time\":" + safeTimeMs
        + "}";

    Debug.Log(">>> ANSWER [" + gameObject.name + "] " + json);
    await SendRaw(json);
}