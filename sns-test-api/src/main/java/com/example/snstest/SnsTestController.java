package com.example.snstest;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.services.sns.SnsClient;
import software.amazon.awssdk.services.sns.model.PublishRequest;

@RestController
@RequestMapping("/api/test")
public class SnsTestController {

    private final SnsClient sns;
    private final String topicArn;

    public SnsTestController(SnsClient sns, @Value("${app.sns.topic-arn}") String topicArn) {
        this.sns = sns;
        this.topicArn = topicArn;
    }

    // Lo que llegue en el cuerpo se publica tal cual en el topic de SNS.
    @PostMapping("/sns")
    public ResponseEntity<Map<String, String>> publish(@RequestBody String body) {
        String messageId = sns.publish(PublishRequest.builder()
                .topicArn(topicArn)
                .message(body)
                .build()).messageId();
        return ResponseEntity.accepted().body(Map.of("messageId", messageId, "topicArn", topicArn));
    }
}
