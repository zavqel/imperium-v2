# Decisões de implementação

## Dados e valores

- Valores financeiros são inteiros em centavos; nunca `REAL`.
- Um agendamento guarda o retrato de cada preço, duração, desconto e veículo.
- Preço excepcional por modelo vence preço por categoria de veículo.
- A ausência de uma regra de preço impede a cotação; a API não usa valor enviado pelo navegador.

## Vagas

- Há um Durable Object por data operacional.
- O objeto serializa reservas temporárias e elimina reservas expiradas por alarme.
- D1 mantém o histórico comercial; o objeto guarda somente o estado de coordenação da agenda.

## Segurança

- A V2 não aceita `Access-Control-Allow-Origin: *`.
- Credenciais de pagamento serão segredos do Worker.
- A autenticação administrativa e os endpoints de pagamento entram somente após a definição do domínio/origem final.
