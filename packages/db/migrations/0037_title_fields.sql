-- What the Florida title forms ask for beyond the deal: the buyer's sex and county, and the vehicle's title.
alter table deals add column if not exists buyer_sex text check (buyer_sex is null or buyer_sex in ('M', 'F', 'X'));
alter table deals add column if not exists buyer_county text;
alter table vehicles add column if not exists title_number text;
alter table vehicles add column if not exists title_state text not null default 'FL';
alter table vehicles add column if not exists title_issued_on date;
