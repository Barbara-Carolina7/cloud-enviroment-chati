package com.example.snstest;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.services.sns.SnsClient;

@Configuration
public class SnsConfig {

    // Sin regi?n, claves ni endpoint en el c?digo: todo sale del entorno (AWS_REGION, credenciales y
    // AWS_ENDPOINT_URL). Por eso el mismo c?digo sirve para LocalStack y para AWS real.
    @Bean
    public SnsClient snsClient() {
        return SnsClient.create();
    }
}
