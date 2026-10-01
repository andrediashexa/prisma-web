//! The typed routing table (`RouteService`, Prisma 0.149.2, #27): one page of
//! a snapshot at a time, never the whole table. A box without the service
//! answers UNIMPLEMENTED, which reaches the front as 501 so it can fall back
//! to the text of `show ip route`.

use axum::extract::{Path, Query, State};
use axum::Json;
use prisma_proto::v1::*;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::grpc::{self, req};
use crate::AppState;

/// Prisma's own ceiling for a page.
const MAX_PAGE: u32 = 5000;

/// Every field is a string so that an empty `family=` from a form means "any"
/// instead of a rejection outside the JSON error format.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RoutesQuery {
    vrf: String,
    family: String,
    prefix: String,
    protocol: String,
    selected: String,
    page_size: String,
    page_token: String,
}

impl RoutesQuery {
    fn into_request(self) -> AppResult<ListRoutesRequest> {
        let family = match self.family.trim() {
            "" | "0" => 0,
            "4" => 4,
            "6" => 6,
            other => return Err(AppError::BadRequest(format!("family must be 4 or 6, not '{other}'"))),
        };
        let selected_only = match self.selected.trim() {
            "" | "false" | "0" => false,
            "true" | "1" => true,
            other => return Err(AppError::BadRequest(format!("selected must be true or false, not '{other}'"))),
        };
        let page_size = match self.page_size.trim() {
            "" => 0,
            n => n
                .parse::<u32>()
                .map_err(|_| AppError::BadRequest(format!("page_size must be a number, not '{n}'")))?
                .min(MAX_PAGE),
        };
        Ok(ListRoutesRequest {
            vrf: self.vrf.trim().to_string(),
            family,
            prefix: self.prefix.trim().to_string(),
            protocol: self.protocol.trim().to_lowercase(),
            selected_only,
            page_size,
            page_token: self.page_token.trim().to_string(),
            ..Default::default()
        })
    }
}

/// `GET /routers/{id}/routes`: a page of routes. Without `page_token` the box
/// takes a new snapshot with the filters; with one, the filters are the
/// snapshot's and an expired token answers 409.
pub async fn list(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<RoutesQuery>,
) -> AppResult<Json<ListRoutesResponse>> {
    let msg = q.into_request()?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.routes().list_routes(grpc::req_with(msg, grpc::ROUTES_TIMEOUT)).await?.into_inner()))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SummaryQuery {
    vrf: String,
}

/// `GET /routers/{id}/routes/summary`: RIB and FIB counts per VRF, family and protocol.
pub async fn summary(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SummaryQuery>,
) -> AppResult<Json<GetRouteSummaryResponse>> {
    let r = st.routers.get(id).await?;
    let msg = GetRouteSummaryRequest { vrf: q.vrf.trim().to_string(), ..Default::default() };
    Ok(Json(r.routes().get_route_summary(req(msg)).await?.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &str) -> AppResult<ListRoutesRequest> {
        let uri: axum::http::Uri = format!("/routes?{pairs}").parse().unwrap();
        Query::<RoutesQuery>::try_from_uri(&uri).unwrap().0.into_request()
    }

    #[test]
    fn query_maps_to_list_routes() {
        let r = q("vrf=red&family=6&prefix=+2001:db8::/32&protocol=BGP&selected=true&page_size=9000&page_token=").unwrap();
        assert_eq!((r.vrf.as_str(), r.family, r.prefix.as_str(), r.protocol.as_str()), ("red", 6, "2001:db8::/32", "bgp"));
        assert!(r.selected_only);
        assert_eq!(r.page_size, MAX_PAGE, "capped at Prisma's ceiling");
        // Empty fields from a form are "any".
        let r = q("family=&selected=&page_size=").unwrap();
        assert_eq!((r.family, r.selected_only, r.page_size), (0, false, 0));
    }

    #[test]
    fn bad_query_is_refused() {
        for bad in ["family=5", "selected=yes", "page_size=-1", "page_size=lots"] {
            assert!(matches!(q(bad), Err(AppError::BadRequest(_))), "{bad}");
        }
    }
}
