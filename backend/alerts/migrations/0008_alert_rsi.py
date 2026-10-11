from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("alerts", "0007_alert_macd_approach_state")]

    operations = [
        migrations.AlterField(
            model_name="alert",
            name="kind",
            field=models.CharField(
                choices=[("price", "Price"), ("macd", "MACD cross"), ("rsi", "RSI level")],
                default="price",
                max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="alert",
            name="rsi_level",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=5, null=True),
        ),
        migrations.AddField(
            model_name="alert",
            name="last_rsi",
            field=models.FloatField(blank=True, null=True),
        ),
    ]
