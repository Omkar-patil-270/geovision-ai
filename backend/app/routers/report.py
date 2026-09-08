# backend/app/routers/report.py
import io
import re
from datetime import datetime, timezone
from typing import Any, Optional
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)

router = APIRouter()


class ReportRequest(BaseModel):
    location_name: str
    predictions: Optional[dict] = None
    story: Optional[Any] = ""
    validation: Optional[dict] = None


def _format_pop(v):
    if v is None:
        return "—"
    if v >= 1e7:
        return f"{v / 1e7:.2f} Cr"
    if v >= 1e5:
        return f"{v / 1e5:.2f} L"
    try:
        return f"{int(v):,}"
    except Exception:
        return str(v)


@router.post("/generate")
async def generate_report(req: ReportRequest):
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=1.5 * cm,
        leftMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "DocTitle",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=22,
        textColor=colors.HexColor("#0f172a"),
    )
    subtitle_style = ParagraphStyle(
        "DocSubtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#64748b"),
    )
    h2_style = ParagraphStyle(
        "H2",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        textColor=colors.HexColor("#1e293b"),
        spaceBefore=8,
        spaceAfter=3,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=12,
        textColor=colors.HexColor("#334155"),
    )
    story_h_style = ParagraphStyle(
        "StoryH",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=9.5,
        leading=13,
        textColor=colors.HexColor("#0284c7"),
        spaceBefore=5,
        spaceAfter=2,
    )

    story_elements = []

    # Header
    story_elements.append(Paragraph(f"GeoVisionAI — {req.location_name} Report", title_style))
    date_str = datetime.now(timezone.utc).strftime("%B %d, %Y · %H:%M UTC")
    story_elements.append(Paragraph(f"Date Generated: {date_str} · GeoVisionAI Intelligence Platform", subtitle_style))
    story_elements.append(Spacer(1, 3 * mm))
    story_elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#cbd5e1"), spaceAfter=6))

    predictions = req.predictions or {}
    pop_data = predictions.get("population", {})
    aqi_data = predictions.get("aqi", {})
    weather_data = predictions.get("weather", {})
    migration_data = predictions.get("migration", {})

    # 1. Summary of Current Indicators
    story_elements.append(Paragraph("1. Current Indicators & Sensor Feeds", h2_style))
    key_metrics_data = [
        ["Indicator", "Current Reading", "Source / Reference", "Forecast Outlook"],
        [
            "Population",
            _format_pop(pop_data.get("current")),
            pop_data.get("source") or "WorldPop / Census Reference",
            f"ARIMA 5-Year ({len(pop_data.get('forecast_5yr', []))} periods)",
        ],
        [
            "Air Quality (AQI)",
            f"{aqi_data.get('current')} AQI" if aqi_data.get("current") is not None else "—",
            predictions.get("aqi_station") or "OpenAQ / Open-Meteo Modeled",
            "5-step ARIMA forecast",
        ],
        [
            "Temperature",
            f"{weather_data.get('current')} °C" if weather_data.get("current") is not None else "—",
            "Open-Meteo Historical Archive",
            "SARIMA 24-month forecast",
        ],
        [
            "Migration Signal",
            f"{migration_data.get('current')} nW/cm²/sr" if migration_data.get("current") is not None else "—",
            "NOAA / VIIRS Nighttime Radiance",
            "5-step ARIMA forecast",
        ],
    ]
    t_summary = Table(key_metrics_data, colWidths=[3.5 * cm, 3.5 * cm, 5.5 * cm, 5.0 * cm])
    t_summary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story_elements.append(t_summary)
    story_elements.append(Spacer(1, 3 * mm))

    # 2. Population: Historical + Validation Table + Error Metrics
    story_elements.append(Paragraph("2. Population Historical Data & Expanding-Window ARIMA Validation", h2_style))
    pop_source = pop_data.get("source") or "WorldPop (District boundary)"
    story_elements.append(Paragraph(f"<b>Source:</b> {pop_source}", body_style))
    story_elements.append(Spacer(1, 2 * mm))

    hist_list = pop_data.get("historical", [])
    if hist_list:
        hist_table_data = [["Year", "Population", "Data Type"]]
        for h in hist_list:
            hist_table_data.append([
                str(h.get("year", "")),
                _format_pop(h.get("value")),
                (h.get("type") or "Estimated").title(),
            ])
        t_hist = Table(hist_table_data, colWidths=[3 * cm, 4 * cm, 4 * cm])
        t_hist.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#334155")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
            ("ALIGN", (0, 0), (-1, -1), "LEFT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ]))
        story_elements.append(t_hist)
        story_elements.append(Spacer(1, 2.5 * mm))

    # Expanding-Window Validation Table & Metrics
    val_data = req.validation or (pop_data.get("model") or {}).get("validation") or {}
    val_rows = val_data.get("validation_rows", [])
    if val_rows:
        story_elements.append(Paragraph("<b>Expanding-Window Validation Table</b> (chronological, no future leakage):", body_style))
        story_elements.append(Spacer(1, 1.5 * mm))

        v_table_data = [["Training Period", "Test Year", "Actual", "Predicted", "Abs Error", "MAE", "RMSE", "MAPE"]]
        for r in val_rows:
            v_table_data.append([
                f"{r.get('train_start')}–{r.get('train_end')}",
                str(r.get("test_year")),
                _format_pop(r.get("actual")),
                _format_pop(r.get("predicted")),
                _format_pop(r.get("abs_error")),
                _format_pop(r.get("mae")),
                _format_pop(r.get("rmse")),
                f"{r.get('mape'):.2f}%" if r.get("mape") is not None else "—",
            ])
        v_table_data.append([
            "OVERALL",
            f"{len(val_rows)} Tests",
            "—",
            "—",
            "—",
            _format_pop(val_data.get("mae")),
            _format_pop(val_data.get("rmse")),
            f"{val_data.get('mape'):.2f}%" if val_data.get('mape') is not None else "—",
        ])

        t_val = Table(v_table_data, colWidths=[2.6 * cm, 1.8 * cm, 2.5 * cm, 2.5 * cm, 2.3 * cm, 2.0 * cm, 2.0 * cm, 1.8 * cm])
        t_val.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.HexColor("#f1f5f9"), colors.white]),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#e2e8f0")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#94a3b8")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("ALIGN", (0, 0), (0, -1), "LEFT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
        ]))
        story_elements.append(t_val)
        story_elements.append(Spacer(1, 2 * mm))

        mae_str = _format_pop(val_data.get("mae"))
        rmse_str = _format_pop(val_data.get("rmse"))
        mape_str = f"{val_data.get('mape'):.2f}%" if val_data.get("mape") is not None else "—"
        story_elements.append(Paragraph(
            f"<b>Forecasting Error Metrics:</b> MAE: <b>{mae_str}</b>  |  RMSE: <b>{rmse_str}</b>  |  MAPE: <b>{mape_str}</b>",
            body_style,
        ))
    else:
        story_elements.append(Paragraph("<i>Reference fallback estimate; multi-year validation requires series history.</i>", subtitle_style))

    story_elements.append(Spacer(1, 3.5 * mm))

    # 3. Forecast Projections: AQI, Weather, Migration
    story_elements.append(Paragraph("3. Environmental & Migration Forecasts", h2_style))
    fc_rows = [["Layer", "Current Value", "Forecast Projection"]]

    aqi_fc = aqi_data.get("forecast_5yr", [])
    aqi_fc_str = ", ".join([f"{f.get('year')}: {f.get('value')} AQI" for f in aqi_fc[:5]]) if aqi_fc else "Projection unavailable"
    fc_rows.append(["Air Quality (AQI)", f"{aqi_data.get('current')} AQI" if aqi_data.get("current") is not None else "—", aqi_fc_str])

    weather_fc = weather_data.get("forecast_5yr", [])
    weather_fc_str = ", ".join([f"{f.get('year')}: {f.get('value')}°C" for f in weather_fc[:5]]) if weather_fc else "Projection unavailable"
    fc_rows.append(["Weather / Temp", f"{weather_data.get('current')} °C" if weather_data.get("current") is not None else "—", weather_fc_str])

    mig_fc = migration_data.get("forecast_5yr", [])
    mig_fc_str = ", ".join([f"{f.get('year')}: {f.get('value')} nW" for f in mig_fc[:5]]) if mig_fc else "Projection unavailable"
    fc_rows.append(["Migration / Growth", f"{migration_data.get('current')} nW/cm²/sr" if migration_data.get("current") is not None else "—", mig_fc_str])

    t_fc = Table(fc_rows, colWidths=[4 * cm, 4 * cm, 9.5 * cm])
    t_fc.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    story_elements.append(t_fc)
    story_elements.append(Spacer(1, 3.5 * mm))

    # 4. AI Story Sections (All 6 sections)
    story_elements.append(Paragraph("4. AI Geospatial Intelligence Story (All 6 Sections)", h2_style))
    story_dict = {}
    if isinstance(req.story, dict):
        story_dict = req.story
    elif isinstance(req.story, str) and req.story:
        story_dict = {"overview": req.story}

    sections_order = ["overview", "history", "culture", "economy", "attractions", "facts"]
    section_titles = {
        "overview": "🧭 Overview",
        "history": "🏛 History",
        "culture": "🎭 Culture",
        "economy": "💼 Economy",
        "attractions": "📍 Attractions",
        "facts": "✨ Facts",
    }

    for sec in sections_order:
        title = section_titles.get(sec, sec.title())
        content = story_dict.get(sec)
        if not content and sec == "overview" and isinstance(req.story, str):
            content = req.story
        if content:
            story_elements.append(Paragraph(title, story_h_style))
            paragraphs = str(content).strip().split("\n\n")
            for p_text in paragraphs:
                p_clean = p_text.strip().replace("\n", " ")
                if p_clean:
                    story_elements.append(Paragraph(p_clean, body_style))
            story_elements.append(Spacer(1, 2 * mm))

    doc.build(story_elements)
    buffer.seek(0)
    pdf_bytes = buffer.getvalue()

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", req.location_name).strip("._").lower() or "location"
    filename = f"geovisionai-{safe_name}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Type": "application/pdf",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
